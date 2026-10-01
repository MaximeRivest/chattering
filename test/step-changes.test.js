'use strict';
// What each step changed (design/88): seen in the steps' snapshots, whatever
// wrote the file; told apart from what ran beside it; read from the
// conversation when there are no snapshots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CheckpointStore } = require('../checkpoint-store');
const { stepTargets } = require('../checkpoint-extension');
const { createStepChanges, namedPaths } = require('../step-changes');
const { fixtureCleanup } = require('./helpers/fixture-cleanup');

function gitIn(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

// A project in Git, a conversation file, a checkpoint store, and a way to
// run a step: saved before, the change made, saved after (as
// checkpoint-extension.js does in a live Pi session).
async function world(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'step-changes-')));
  const cleanup = fixtureCleanup(t, () => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'proj'); await fs.mkdir(root);
  gitIn(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'app.js'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(root, 'b.js'), 'b\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'out/\n');
  gitIn(root, ['add', '-A']); gitIn(root, ['commit', '-qm', 'start']);
  const cp = new CheckpointStore(path.join(dir, 'private'));
  cleanup.add(() => cp.close());
  const session = path.join(dir, 'conv.jsonl');
  const rows = [{ type: 'session', version: 3, id: 'c', cwd: root }];
  const recorded = [];
  let n = 0;
  const writeSession = () => fs.writeFile(session, rows.map(JSON.stringify).join('\n') + '\n');
  const addCall = (id, name, input, { done = true, error = false } = {}) => {
    const ts = new Date(Date.UTC(2026, 8, 1, 12, 0, n++)).toISOString();
    rows.push({ type: 'message', id: 'a' + id, timestamp: ts, message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: input }] } });
    if (done) rows.push({ type: 'message', id: 'r' + id, timestamp: ts, message: { role: 'toolResult', toolCallId: id, toolName: name, isError: error, content: [{ type: 'text', text: 'ok' }] } });
  };
  // A step with snapshots. `during` runs between this step's before and after.
  const step = async (id, name, input, change, { sessionFile = session, run = 'run', done = true, during = null } = {}) => {
    const meta = { session: sessionFile, call: id, run, tool: name, targets: stepTargets(name, input, root) };
    await cp.capture(root, { ...meta, phase: 'before' });
    if (during) await during();
    await change();
    if (done) await cp.capture(root, { ...meta, phase: 'after' });
    if (sessionFile === session) addCall(id, name, input, { done });
    await writeSession();
  };
  const service = (extra = {}) => createStepChanges({
    store: () => cp, session: () => ({ file: session, cwd: root }), recorded: async () => recorded, ...extra,
  });
  return { dir, root, cp, session, step, addCall, writeSession, recorded, service, file: p => path.join(root, p) };
}
const summary = files => files.map(f => [f.rel, f.kind, f.how, f.add, f.del]);

test('what a step names: an edit tool\u2019s path, a command\u2019s outputs', () => {
  const cwd = path.resolve('/w');
  assert.deepEqual([...namedPaths({ name: 'edit', input: { path: 'a.js' } }, cwd)], [path.join(cwd, 'a.js')]);
  assert.deepEqual([...namedPaths({ name: 'Write', input: { file_path: '/x/b.md' } }, cwd)], [path.resolve('/x/b.md')]);
  assert.deepEqual([...namedPaths({ name: 'bash', input: { command: 'python gen.py > out/a.txt && cp a b' } }, cwd)].sort(), [path.join(cwd, 'b'), path.join(cwd, 'out/a.txt')].sort());
  assert.deepEqual([...namedPaths({ name: 'read', input: { path: 'a.js' } }, cwd)], []);
});

test('observed: an edit, a new file, and a script\u2019s outputs it never named', async t => {
  const w = await world(t);
  await w.step('e1', 'edit', { path: w.file('app.js'), edits: [{ oldText: 'two\n', newText: 'TWO\nand a half\n' }] }, () => fs.writeFile(w.file('app.js'), 'one\nTWO\nand a half\nthree\n'));
  await w.step('w1', 'write', { path: w.file('docs/a.md'), content: '# A\n\ntext\n' }, async () => { await fs.mkdir(w.file('docs')); await fs.writeFile(w.file('docs/a.md'), '# A\n\ntext\n'); });
  await w.step('b1', 'bash', { command: 'python3 gen.py' }, () => fs.writeFile(w.file('data.csv'), 'x\n1\n'));
  await w.step('b2', 'bash', { command: 'rm b.js' }, () => fs.rm(w.file('b.js')));
  const out = await w.service().changes('k', [['e1', 'w1', 'b1', 'b2']]);
  assert.deepEqual(summary(out.groups[0].files), [
    ['app.js', 'modified', 'named', 2, 1],
    ['b.js', 'deleted', 'named', 0, 1],
    ['data.csv', 'added', 'observed', 2, 0],
    ['docs/a.md', 'added', 'named', 3, 0],
  ]);
  assert.deepEqual(Object.keys(out.steps).sort(), ['b1', 'b2', 'e1', 'w1']);
  assert.deepEqual([out.observed, out.total], [4, 4]);
  // The change itself, both versions, and the file now.
  const c = await w.service().content('k', ['e1'], w.file('app.js'));
  assert.deepEqual([c.old.text, c.next.text, c.current], ['one\ntwo\nthree\n', 'one\nTWO\nand a half\nthree\n', 'same']);
  await fs.writeFile(w.file('app.js'), 'later\n');
  const later = await w.service().content('k', ['e1'], w.file('app.js'));
  assert.deepEqual([later.current, later.now], ['changed', 'later\n']);
  await assert.rejects(w.service().content('k', ['e1'], w.file('b.js')), /did not change in these steps/);
});

test('an edit tool is not credited with what changed beside it', async t => {
  const w = await world(t);
  await w.step('e1', 'edit', { path: w.file('app.js'), edits: [] }, async () => {
    await fs.writeFile(w.file('app.js'), 'one\n');
    await fs.writeFile(w.file('b.js'), 'someone else\n');
  });
  const out = await w.service().changes('k', [['e1']]);
  assert.deepEqual(summary(out.groups[0].files), [['app.js', 'modified', 'named', 0, 2]]);
  assert.deepEqual(out.groups[0].during, []);
});

test('work beside a step: another conversation\u2019s step is subtracted; one still running leaves it unclaimed', async t => {
  const w = await world(t);
  const other = path.join(w.dir, 'other.jsonl');
  // Another conversation's step, begun and finished while ours ran: its file is its own.
  await w.step('b1', 'bash', { command: 'npm test' }, () => fs.writeFile(w.file('data.csv'), 'mine\n'), {
    during: async () => {
      const meta = { session: other, call: 'x1', run: 'r2', tool: 'edit', targets: [] };
      await w.cp.capture(w.root, { ...meta, phase: 'before' });
      await fs.writeFile(w.file('b.js'), 'theirs\n');
      await w.cp.capture(w.root, { ...meta, phase: 'after' });
    },
  });
  let out = await w.service().changes('k', [['b1']]);
  assert.deepEqual(summary(out.groups[0].files), [['data.csv', 'added', 'observed', 1, 0]], 'b.js was the other conversation\u2019s');
  // Another step that has not finished: what changed meanwhile is not claimed.
  await w.step('b2', 'bash', { command: 'make' }, () => fs.writeFile(w.file('built.txt'), 'x\n'), {
    during: () => w.cp.capture(w.root, { session: other, call: 'x2', run: 'r3', tool: 'bash', targets: [], phase: 'before' }),
  });
  out = await w.service().changes('k2', [['b2']]);
  assert.deepEqual(out.groups[0].files, []);
  assert.deepEqual(summary(out.groups[0].during), [['built.txt', 'added', 'observed', 1, 0]]);
  // An edit another conversation recorded (no snapshots of its own) is its own too.
  await w.step('b3', 'bash', { command: 'true' }, () => fs.writeFile(w.file('app.js'), 'edited elsewhere\n'));
  const peerEdits = async () => [{ path: w.file('app.js'), ts: new Date().toISOString() }];
  out = await w.service({ peerEdits }).changes('k3', [['b3']]);
  assert.deepEqual(out.groups[0].files, []);
});

test('a box of steps: the net change per file; changed and changed back is nothing', async t => {
  const w = await world(t);
  const edit = (id, from, to) => w.step(id, 'edit', { path: w.file('app.js'), edits: [{ oldText: from, newText: to }] }, async () => {
    const text = await fs.readFile(w.file('app.js'), 'utf8'); await fs.writeFile(w.file('app.js'), text.replace(from, to));
  });
  await edit('e1', 'two', 'TWO'); await edit('e2', 'three', 'THREE');
  await w.step('e3', 'edit', { path: w.file('b.js'), edits: [] }, () => fs.writeFile(w.file('b.js'), 'B\n'));
  await w.step('e4', 'edit', { path: w.file('b.js'), edits: [] }, () => fs.writeFile(w.file('b.js'), 'b\n'));
  const out = await w.service().changes('k', [['e1', 'e2', 'e3', 'e4'], ['e1'], ['e2']]);
  const [all, first, second] = out.groups;
  assert.deepEqual(summary(all.files), [['app.js', 'modified', 'named', 2, 2]], 'b.js is back as it was');
  assert.equal(all.files[0].steps, 2);
  assert.deepEqual(summary(first.files), [['app.js', 'modified', 'named', 1, 1]]);
  assert.deepEqual(summary(second.files), [['app.js', 'modified', 'named', 1, 1]]);
  const c = await w.service().content('k', ['e1', 'e2', 'e3', 'e4'], w.file('app.js'));
  assert.deepEqual([c.old.text, c.next.text], ['one\ntwo\nthree\n', 'one\nTWO\nTHREE\n']);
});

test('a command\u2019s outputs outside Git\u2019s view are saved by name, and a folder or a failure never warns', async t => {
  const w = await world(t);
  await fs.mkdir(w.file('out'));
  await w.step('b1', 'bash', { command: 'node run.js > out/log.txt' }, () => fs.writeFile(w.file('out/log.txt'), 'a\nb\n'));
  await w.step('b2', 'bash', { command: 'node run.js >> out/log.txt' }, () => fs.appendFile(w.file('out/log.txt'), 'c\n'));
  const out = await w.service().changes('k', [['b1'], ['b2'], ['b1', 'b2']]);
  assert.deepEqual(summary(out.groups[0].files), [['out/log.txt', 'added', 'named', 2, 0]], 'ignored by Git, observed all the same');
  assert.deepEqual(summary(out.groups[1].files), [['out/log.txt', 'modified', 'named', 1, 0]]);
  assert.deepEqual(summary(out.groups[2].files), [['out/log.txt', 'added', 'named', 3, 0]]);
  const c = await w.service().content('k', ['b2'], w.file('out/log.txt'));
  assert.deepEqual([c.old.text, c.next.text], ['a\nb\n', 'a\nb\nc\n']);
  // A named folder: nothing saved for it, and no complaint.
  const res = await w.cp.capture(w.root, { session: w.session, call: 'b3', run: 'run', tool: 'bash', phase: 'before', targets: stepTargets('bash', { command: 'rm -rf out' }, w.root) });
  assert.deepEqual(res.targetErrors, []);
  assert.ok(w.cp.targets(res.id).some(x => x.error), 'the folder was tried and skipped');
});

test('a command\u2019s output no snapshot covered: read from the command, the file as it is now', async t => {
  const w = await world(t);
  await fs.mkdir(w.file('out'));
  // A step saved before the outputs were saved by name (older conversations).
  const meta = { session: w.session, call: 'b1', run: 'run', tool: 'bash', targets: [] };
  await w.cp.capture(w.root, { ...meta, phase: 'before' });
  await fs.writeFile(w.file('out/report.txt'), 'r1\nr2\n');
  await w.cp.capture(w.root, { ...meta, phase: 'after' });
  w.addCall('b1', 'bash', { command: 'report > out/report.txt; rm -rf out/cache' }); await w.writeSession();
  const out = await w.service().changes('k', [['b1']]);
  assert.deepEqual(summary(out.groups[0].files), [['out/report.txt', 'written', 'command', 2, null]], 'out/cache is not there: nothing claimed');
  const c = await w.service().content('k', ['b1'], w.file('out/report.txt'));
  assert.deepEqual([c.next.text, c.next.now, c.old.unavailable], ['r1\nr2\n', true, 'not saved']);
});

test('no snapshots: the recorded edit, rebuilt around today\u2019s file', async t => {
  const w = await world(t);
  const file = w.file('app.js');
  // Two recorded edits (as Claude Code leaves them), the file as they left it.
  w.addCall('c1', 'Edit', { file_path: file, old_string: 'two', new_string: 'TWO' });
  w.addCall('c2', 'Edit', { file_path: file, old_string: 'three', new_string: 'THREE' });
  w.addCall('c3', 'Write', { file_path: w.file('new.md'), content: 'hello\nworld\n' });
  await w.writeSession();
  await fs.writeFile(file, 'one\nTWO\nTHREE\n'); await fs.writeFile(w.file('new.md'), 'hello\nworld\n');
  const ev = (callId, p, kind, oldText, newText) => ({ callId, path: p, kind, oldText, newText, outcome: 'applied', ts: '' });
  w.recorded.push(ev('c1', file, 'edit', 'two', 'TWO'), ev('c2', file, 'edit', 'three', 'THREE'), ev('c3', w.file('new.md'), 'write', null, 'hello\nworld\n'));
  const out = await w.service().changes('k', [['c1'], ['c1', 'c2', 'c3']]);
  assert.deepEqual(summary(out.groups[0].files), [['app.js', 'modified', 'recorded', 1, 1]]);
  assert.deepEqual(summary(out.groups[1].files), [['app.js', 'modified', 'recorded', 2, 2], ['new.md', 'written', 'recorded', 2, 0]]);
  assert.equal(out.observed, 0);
  // The first edit alone: the later one undone from today's file, then this one.
  const first = await w.service().content('k', ['c1'], file);
  assert.deepEqual([first.old.text, first.next.text, first.rebuilt], ['one\ntwo\nthree\n', 'one\nTWO\nthree\n', true]);
  // The text around it no longer found: the edit alone, as recorded.
  await fs.writeFile(file, 'rewritten\n');
  const lost = await w.service().content('k', ['c2'], file);
  assert.deepEqual(lost.hunks, [{ old: 'three', next: 'THREE' }]);
  const written = await w.service().content('k', ['c3'], w.file('new.md'));
  assert.equal(written.next.text, 'hello\nworld\n');
});

test('temporary folders are scratch, unless the project lives there', async t => {
  const w = await world(t);
  await w.step('e1', 'edit', { path: w.file('app.js'), edits: [] }, () => fs.writeFile(w.file('app.js'), 'x\n'));
  const out = await w.service({ isScratch: p => p.endsWith('app.js') }).changes('k', [['e1']]);
  assert.equal(out.groups[0].files[0].scratch, true);
});

test('a step still running: listed, and asked about again', async t => {
  const w = await world(t);
  await w.step('b1', 'bash', { command: 'long > out.txt' }, () => fs.writeFile(w.file('out.txt'), '1\n'), { done: false });
  const out = await w.service().changes('k', [['b1']]);
  assert.equal(out.groups[0].pending, true);
});

test('many snapshot pairs compared by one Git process: paths with spaces, binaries', async t => {
  const w = await world(t);
  // Win32 filenames cannot contain a tab. Keep the actual snapshot-pair
  // comparison there with a space and Unicode; POSIX still covers tabs.
  const textName = process.platform === 'win32' ? 'a b λ.txt' : 'a b\tc.txt';
  await w.step('b1', 'bash', { command: 'x' }, async () => {
    await fs.writeFile(w.file(textName), 'x\n');
    await fs.writeFile(w.file('pic.bin'), Buffer.from([0, 1, 2, 3]));
  });
  const out = await w.service().changes('k', [['b1']]);
  assert.deepEqual(summary(out.groups[0].files), [[textName, 'added', 'observed', 1, 0], ['pic.bin', 'added', 'observed', null, null]]);
  assert.equal(out.groups[0].files[1].binary, true);
});
