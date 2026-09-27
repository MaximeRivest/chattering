'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore, git } = require('../checkpoint-store');
const { ChangeReviews } = require('../change-reviews');
const { FileArchive } = require('../file-archive');
const L = require('../task-locations');
const repair = require('../review-repair');
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-review-')));
  const root = path.join(dir, 'work'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'scratch'));
  await fs.writeFile(path.join(root, '.gitignore'), 'scratch/\n');
  await fs.writeFile(path.join(root, 'core.py'), 'core before');
  await fs.writeFile(path.join(root, 'scratch/wizard.py'), 'wizard before');
  await git(['init'], { cwd: root });
  const cp = new CheckpointStore(path.join(dir, 'private'));
  const archive = new FileArchive(path.join(dir, 'archive', 'history.sqlite'));
  const reviews = new ChangeReviews(cp, { archive });
  t.after(async () => { cp.close(); archive.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const tool = { id: 'write', name: 'edit', ts: new Date().toISOString(), success: true, input: { path: 'scratch/wizard.py', edits: [{ oldText: 'wizard before', newText: 'wizard after' }] } };
  const args = { key: 'session-key', session: '/session', project: 'work', cwd: root, calls: [tool.id], tools: [tool], title: 'one step' };
  return { dir, root, cp, archive, reviews, tool, args };
}
test('SSH and heredoc outputs keep remote cwd/host, including stderr redirects', () => {
  const command = `ssh max@build 'cd /tmp/job && nohup env X=1 timeout 10s python - > run.log 2>&1 <<"PY" &\nfrom pathlib import Path\nPath("SUCCESS").write_text("ok")\nPath("FAILED").write_text("bad")\nPY\nwait'`;
  const result = L.inspectShell(command, { host: 'local', cwd: '/local/project' });
  assert.deepEqual(result.locations.map(l => [l.host, l.path]).sort(), [['max@build', '/tmp/job/FAILED'], ['max@build', '/tmp/job/SUCCESS'], ['max@build', '/tmp/job/run.log']].sort());
  const outer = L.inspectShell(`ssh max@build 'cd /tmp/job; tee resume.py >/dev/null' <<'PY'\nPath("out.json").write_text("ok")\nPY`, { host: 'local', cwd: '/project' });
  assert.ok(outer.locations.some(l => l.path === '/tmp/job/resume.py'));
  assert.ok(!outer.locations.some(l => l.path === '/project/out.json' || l.raw === 'PY'));
});
test('copy commands connect remote artifacts to local copies without claiming equal contents', () => {
  const tools = [{ id: 'make', name: 'bash', input: { command: `ssh user@host 'cd /tmp/run; python - <<"PY"\nfig.savefig("plot.png")\nPY'` } },
    { id: 'copy', name: 'bash', input: { command: 'rsync -az user@host:/tmp/run/{plot.png,summary.json} scratch/results/' } }];
  const data = L.gather(tools, '/project');
  const remote = data.locations.find(l => l.host === 'user@host' && l.path === '/tmp/run/plot.png');
  assert.deepEqual(remote.localCopies, ['/project/scratch/results/plot.png']);
  assert.equal(L.location('relative.txt', { host: 'host', cwd: null }).path, null);
  assert.equal(L.location('$OUT/file', { host: 'local', cwd: '/project' }).path, null);
});
test('explicit ignored targets are captured and unrelated task edits remain separate', async t => {
  const { root, cp, reviews, tool, args } = await fixture(t);
  const meta = { session: args.session, call: tool.id, run: 'run', tool: 'edit', targets: L.directTargets(tool.name, tool.input, root) };
  await cp.capture(root, { ...meta, phase: 'before' });
  await fs.writeFile(path.join(root, 'core.py'), 'changed by another task');
  await fs.writeFile(path.join(root, 'scratch/wizard.py'), 'wizard after');
  await cp.capture(root, { ...meta, phase: 'after' });
  const r = await reviews.createTask(args);
  assert.equal(r.schema, 2);
  assert.deepEqual(r.files.map(f => f.path), ['scratch/wizard.py']);
  assert.deepEqual(r.otherFiles.map(f => f.path), ['core.py']);
  assert.equal(r.files[0].oldRef.kind, 'target');
  const content = await reviews.file(r.id, 'scratch/wizard.py');
  assert.equal(content.old.text, 'wizard before'); assert.equal(content.next.text, 'wizard after');
  await assert.rejects(reviews.file(r.id, 'core.py'), /not in/);
  assert.equal((await reviews.file(r.id, 'core.py', '', false, 'other')).next.text, 'changed by another task');
  const comment = await reviews.comment(r.id, { path: 'scratch/wizard.py', line: 1, text: 'Keep this scoped' });
  assert.equal(comment.quote, 'wizard after');
  const other = await reviews.comment(r.id, { path: 'core.py', scope: 'other', line: 1, text: 'Separate work' });
  assert.equal(other.scope, 'other');
});
test('a polling Bash call does not own changes made while it waits', async t => {
  const { root, cp, reviews, args } = await fixture(t);
  const tool = { id: 'poll', name: 'bash', ts: new Date().toISOString(), input: { command: "sleep 240; ssh user@host 'tail /tmp/run.log'" }, success: true };
  const meta = { session: args.session, call: tool.id, run: 'run', tool: 'bash' };
  await cp.capture(root, { ...meta, phase: 'before' });
  await fs.writeFile(path.join(root, 'core.py'), 'another conversation');
  await cp.capture(root, { ...meta, phase: 'after' });
  const r = await reviews.createTask({ ...args, calls: [tool.id], tools: [tool] });
  assert.equal(r.files.length, 0); assert.deepEqual(r.otherFiles.map(f => f.path), ['core.py']);
});
test('experiment scopes capture ignored text, remain reversible and exclude sensitive files', async t => {
  const { root, cp } = await fixture(t);
  await fs.writeFile(path.join(root, 'scratch/.env'), 'secret');
  const before = await fs.readFile(path.join(root, '.gitignore'));
  await cp.approveScope(root, path.join(root, 'scratch'));
  const recorded = await cp.capture(root);
  const manifest = cp.snapshot(recorded.snapshot).manifest;
  assert.ok(manifest.some(f => f.path === 'scratch/wizard.py' && f.oid));
  assert.ok(!manifest.some(f => f.path === 'scratch/.env' && f.oid));
  assert.deepEqual(await fs.readFile(path.join(root, '.gitignore')), before);
  assert.deepEqual(cp.revokeScope(root, path.join(root, 'scratch')), []);
  await assert.rejects(cp.approveScope(root, root), /eligible subfolder/);
});
test('external explicit targets can be diffed without expanding workspace capture', async t => {
  const { dir, root, cp, reviews, tool, args } = await fixture(t);
  const file = path.join(dir, 'outside.py'); await fs.writeFile(file, 'old');
  tool.input = { path: file, edits: [{ oldText: 'old', newText: 'new' }] };
  const meta = { session: args.session, call: tool.id, run: 'run', tool: 'edit', targets: L.directTargets(tool.name, tool.input, root) };
  await cp.capture(root, { ...meta, phase: 'before' }); await fs.writeFile(file, 'new'); await cp.capture(root, { ...meta, phase: 'after' });
  const r = await reviews.createTask(args);
  assert.equal(r.files[0].livePath, file);
  assert.equal((await reviews.file(r.id, file)).next.text, 'new');
  assert.equal((await reviews.localFile(r.id, file)).path, file);
  await assert.rejects(reviews.localFile(r.id, '/etc/passwd'), /No verified/);
});
test('repairs recover saved observations but preserve the original review and comments', async t => {
  const { root, archive, reviews, tool, args } = await fixture(t);
  const file = path.join(root, 'scratch/wizard.py'), now = Date.now();
  tool.ts = new Date(now - 1000).toISOString();
  archive.observe(file, { text: 'wizard before', ts: now - 2000 });
  archive.observe(file, { text: 'wizard after', ts: now });
  const old = reviews.create({ key: args.key, session: args.session, project: args.project, calls: args.calls, knownPaths: ['wrong/path'] });
  await reviews.comment(old.id, { text: 'Keep my original comment' });
  const r = await reviews.createTask({ ...args, repairOf: old.id });
  const data = await reviews.file(r.id, 'scratch/wizard.py');
  assert.equal(data.old.text, 'wizard before'); assert.equal(data.next.text, 'wizard after');
  assert.equal(reviews.get(old.id).comments.length, 1); assert.equal(r.comments.length, 0);
  assert.equal(reviews.get(old.id).repairs[0].id, r.id);
});
test('remote local-copy repair never invents a remote historical diff', async t => {
  const { root, reviews, args } = await fixture(t);
  await fs.writeFile(path.join(root, 'scratch/plot.png'), Buffer.from([137,80,78,71]));
  const tool = { id: 'remote', name: 'bash', ts: new Date().toISOString(), input: { command: 'ssh max@host \'cd /tmp/run; python - <<"PY"\nfig.savefig("plot.png")\nPY\'' } };
  const context = { id: 'copy', name: 'bash', input: { command: 'rsync max@host:/tmp/run/plot.png scratch/plot.png' } };
  const r = await reviews.createTask({ ...args, tools: [tool], calls: [tool.id], contextTools: [tool, context] });
  const artifact = r.artifacts.find(f => f.location.host === 'max@host');
  assert.equal(artifact.livePath, path.join(root, 'scratch/plot.png')); assert.equal(artifact.oldRef, null); assert.equal(artifact.nextRef, null);
  assert.equal((await reviews.localFile(r.id, artifact.path)).mediaType, 'image/png');
});
test('model proposals are opt-in, single-use, bounded and verified locally without remote execution', async t => {
  const { root, reviews, args } = await fixture(t);
  const tool = { id: 'remote', name: 'bash', ts: new Date().toISOString(), input: { command: 'ssh max@host \'cd /tmp/run; python - <<"PY"\nPath("wizard.py").write_text("x")\nPY\'' } };
  const r = await reviews.createTask({ ...args, tools: [tool], calls: [tool.id] });
  const p = repair.preview(reviews, r, [tool], 'fixture'); let requests = 0;
  const invoke = async () => { requests++; return JSON.stringify([{ locationId: r.artifacts[0].locationId, localPath: path.join(root, 'scratch/wizard.py'), reason: 'candidate' }, { locationId: r.artifacts[0].locationId, localPath: '/etc/passwd', reason: 'not permitted' }]); };
  const result = await repair.suggest(reviews, p.token, 'fixture', invoke);
  assert.equal(result.proposals[0].verifiedLocal, true); assert.equal(result.proposals[1].verifiedLocal, false);
  await repair.suggest(reviews, p.token, 'fixture', invoke); assert.equal(requests, 1);
  const overrides = repair.accepted(reviews, r, p.token, 0);
  const corrected = await reviews.createTask({ ...args, tools: [tool], calls: [tool.id], overrides, repairOf: r.id });
  assert.equal(corrected.artifacts[0].livePath, path.join(root, 'scratch/wizard.py'));
  assert.equal(corrected.artifacts[0].nextRef, null);
});
test('secrets are recognized with either separator', () => {
  for (const p of ['/home/u/.ssh/id_rsa', 'C:\\Users\\u\\.ssh\\id_rsa', 'C:\\proj\\.env', 'C:\\proj\\.env.local', 'C:\\Users\\u\\.gnupg\\pubring.kbx', 'C:\\app\\auth.json', 'D:\\x\\credentials.json', 'C:\\a\\cert.pem'])
    assert.equal(L.sensitive(p), true, p);
  for (const p of ['C:\\proj\\environment.md', 'C:\\proj\\sshd-notes.txt', '/home/u/src/key.js']) assert.equal(L.sensitive(p), false, p);
});
test('a temporary folder counts under both its names (macOS: /var/folders is /private/var/folders)', async t => {
  const real = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-temp-real-')));
  const alias = real.replace(/real-(\w+)$/, 'alias-$1');
  await fs.symlink(real, alias, 'dir');
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  t.after(async () => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v; await fs.rm(alias, { force: true }); await fs.rm(real, { recursive: true, force: true }); });
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = alias;
  assert.equal(os.tmpdir(), alias);
  assert.equal(L.permittedLocal(path.join(alias, 'out.py'), '/nowhere/project'), true);
  assert.equal(L.permittedLocal(path.join(real, 'out.py'), '/nowhere/project'), true);
  assert.equal(L.permittedLocal(path.join(path.parse(real).root, 'etc-like', 'x'), '/nowhere/project'), false);
});
