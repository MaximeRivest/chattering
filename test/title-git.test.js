'use strict';
// Execute the server's actual title-amend path against synthetic repositories.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createTitlePublication } = require('../title-publication');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function scheduleDocCommitTitle(');
const end = source.indexOf('// Explicit save =', start);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10); } throw new Error('title fixture timeout'); }
function fixture(t, { finalProbeRace = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['config', 'user.name', 'Title fixture']); git(['config', 'user.email', 'title@example.invalid']);
  fs.writeFileSync(path.join(root, 'doc.md'), 'Original\n'); git(['add', '.']); git(['commit', '-qm', 'plain document subject']);
  const hash = git(['rev-parse', 'HEAD']).trim();
  let allowed = true, allowedActor = true, answer, called = false, completed = false, pending;
  const events = [];
  const p = createTitlePublication({ namesAllowed: () => allowed });
  const finish = p.finish; p.finish = ticket => { completed = true; finish(ticket); };
  const context = vm.createContext({
    execFileSync, titlePublication: p, backgroundAllowed: () => allowed,
    projectOfPath: () => 'fixture', projectCreatorOf: () => null, titleCanAct: () => allowedActor,
    clipped: (x, n) => x.slice(0, n), oneLine: x => x.trim(), broadcast: e => events.push(e),
    aiProgram: () => { called = true; return new Promise(resolve => { answer = () => resolve({ outputs: { title: 'Generated subject' } }); }); },
    gitText: async (_, args) => {
      const result = git(args);
      if (finalProbeRace && args[0] === 'diff') {
        fs.writeFileSync(path.join(root, 'external.md'), 'External staged work'); git(['add', 'external.md']);
      }
      return result;
    },
    setTimeout: fn => { pending = Promise.resolve().then(fn); },
  });
  vm.runInContext(source.slice(start, end), context);
  const schedule = () => context.scheduleDocCommitTitle(root, hash, 'synthetic diff');
  return { root, git, hash, events, p, schedule, answer: () => answer(), pending: () => pending,
    called: () => called, completed: () => completed,
    revoke() { allowed = false; p.policyChanged(); }, enable() { allowed = true; p.policyChanged(); },
    disableActor() { allowedActor = false; } };
}
for (const drift of ['none', 'revoke-reenable', 'actor', 'HEAD', 'stage', 'final-probe-stage']) {
  test(`actual server Git title path: ${drift}`, async t => {
    const f = fixture(t, { finalProbeRace: drift === 'final-probe-stage' });
    f.schedule(); await until(f.called);
    if (drift === 'revoke-reenable') { f.revoke(); f.enable(); }
    if (drift === 'actor') f.disableActor();
    if (drift === 'HEAD') { fs.writeFileSync(path.join(f.root, 'external.md'), 'New work'); f.git(['add', '.']); f.git(['commit', '-qm', 'External commit']); }
    if (drift === 'stage') { fs.writeFileSync(path.join(f.root, 'external.md'), 'Staged work'); f.git(['add', '.']); }
    f.answer(); await f.pending();
    assert.equal(f.completed(), true);
    assert.equal(f.git(['log', '-1', '--format=%s']).trim(), drift === 'none' ? 'Generated subject' : drift === 'HEAD' ? 'External commit' : 'plain document subject');
    assert.equal(f.events.length, drift === 'none' ? 1 : 0);
    if (drift === 'stage' || drift === 'final-probe-stage') assert.match(f.git(['diff', '--cached', '--name-only']), /external.md/);
  });
}
test('actual server title amend waits for the shared repository writer queue', async t => {
  const f = fixture(t); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const writer = f.p.serialize(f.root, () => new Promise(resolve => { entered(); release = resolve; }));
  await ready; f.schedule(); await until(f.called); f.answer();
  await sleep(20);
  assert.equal(f.completed(), false); assert.equal(f.events.length, 0);
  release(); await writer; await f.pending();
  assert.equal(f.git(['log', '-1', '--format=%s']).trim(), 'Generated subject');
});
