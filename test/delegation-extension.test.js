'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const D = require('../delegation');
const S = require('../delegation-store');

const packageDir = require('./helpers/pi-package.js').piPackageForTests() || path.join(__dirname, 'no-pi-package-here');
const loaderPath = path.join(packageDir, 'dist/core/extensions/loader.js');
const available = fs.existsSync(loaderPath);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-extension-')));
  const root = path.join(dir, 'store'), file = path.join(dir, 'parent.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: dir }) + '\n');
  const saved = {};
  for (const key of ['PI_DELEGATION_ROOT', 'PI_DELEGATION_ID', 'PI_DELEGATION_SUPERVISION', 'JITI_FS_CACHE', 'CHATTERING_PI_CLI', 'FIXTURE_STORE']) saved[key] = process.env[key];
  process.env.PI_DELEGATION_ROOT = root;
  process.env.PI_DELEGATION_SUPERVISION = 'detached';
  delete process.env.PI_DELEGATION_ID;
  process.env.JITI_FS_CACHE = 'false';
  process.env.FIXTURE_STORE = require.resolve('../delegation-store');
  // A Pi started as Pi is (node + file, runtime.js), on every system.
  process.env.CHATTERING_PI_CLI = path.join(dir, 'fake-pi.js');
  const script = String.raw`
const fs=require('node:fs'); const args=process.argv.slice(2); const arg=k=>args[args.indexOf(k)+1];
const S=require(process.env.FIXTURE_STORE), mode=JSON.parse(fs.readFileSync(arg('--prompt-mode-file'),'utf8'));
const append=o=>fs.appendFileSync(arg('--session'),JSON.stringify(o)+'\n');
append({type:'custom',customType:'mode-switch',data:{mode:mode.key,definition:mode,sha256:S.sha256(mode),effectiveTools:mode.tools}});
const [provider, modelId]=arg('--model').split('/');
const prompt=fs.readFileSync(args.at(-1).slice(1),'utf8');
const limited=prompt.includes('Fixture limit') && !prompt.startsWith('Your previous attempt');
const message=limited?{role:'assistant',provider,model:modelId,stopReason:'error',errorMessage:'Fixture request failed (429): rate_limit_error',content:[]}:{role:'assistant',provider,model:modelId,stopReason:'stop',content:[{type:'text',text:'Extension fixture done'}]};
append({type:'message',message}); console.log(JSON.stringify({type:'message_end',message}));
`;
  fs.writeFileSync(process.env.CHATTERING_PI_CLI, script);
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const loaded = await loadExtensions([path.resolve(__dirname, '../extensions/delegation.ts')], dir);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const mode = { key: 'fixture', label: 'Fixture', opener: 'Test the extension.', tools: ['read', 'delegate', 'delegation_status', 'delegation_control'] };
  loaded.runtime.getActiveTools = () => mode.tools;
  loaded.runtime.getAllTools = () => mode.tools.map(name => ({ name }));
  let currentFile = file, branch = [], aborts = 0;
  const notices = [], choices = [];
  const ctx = { cwd: dir, mode: 'rpc', hasUI: true, model: { provider: 'fake', id: 'test' }, thinkingLevel: 'off',
    modelRegistry: { find: (provider, id) => provider === 'fake' && ['test', 'other'].includes(id) ? { provider, id } : undefined },
    sessionManager: { getSessionFile: () => currentFile, getLeafId: () => 'actual-leaf', getBranch: () => branch },
    abort: () => { aborts++; },
    ui: { notify: text => notices.push(text), select: async (_title, items) => { choices.push(items); return choices.length === 1 ? items[0] : 'Show saved paths'; }, confirm: async () => true },
  };
  const call = (name, params) => ext.tools.get(name).definition.execute('tool-call', params, new AbortController().signal, undefined, ctx);
  const hook = (name, event = {}) => ext.handlers.get(name)?.[0]?.(event, ctx);
  const done = async id => {
    for (let i = 0; i < 160; i++) { const task = await D.getDelegation(id); if (S.TERMINAL.has(task.status)) return task; await sleep(30); }
    throw new Error('Fixture did not finish');
  };
  t.after(async () => {
    try {
      for (const id of S.allIds(root)) { await D.controlDelegation(id, 'cancel'); await done(id); }
      await sleep(100);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  return { dir, root, file, mode, ctx, ext, notices, choices, call, hook, done,
    setFile: f => { currentFile = f; }, setBranch: b => { branch = b; }, aborts: () => aborts };
}

const skip = !available && 'Pi package is unavailable; set PI_CODING_AGENT_PACKAGE to run extension tests';
test('real Pi extension loader registers standard tools and web-safe dialogs; launch uses context identity', { skip }, async t => {
  const f = await setup(t);
  assert.deepEqual([...f.ext.tools.keys()], ['delegate', 'delegation_status', 'delegation_control', 'delegation_resume', 'delegation_review']);
  assert.ok(f.ext.commands.has('delegations'));
  const stale = process.env.PI_SESSION_FILE;
  process.env.PI_SESSION_FILE = '/stale-shared-session';
  t.after(() => { if (stale === undefined) delete process.env.PI_SESSION_FILE; else process.env.PI_SESSION_FILE = stale; });
  const output = await f.call('delegate', { title: 'Web task', role: 'tester', prompt: 'Fixture only', mode: f.mode, tools: f.mode.tools });
  const task = JSON.parse(output.content[0].text);
  assert.equal(task.parentSessionPath, f.file); assert.equal(task.parentEntryId, 'actual-leaf'); assert.equal(task.delivery, 'web');
  assert.equal((await f.done(task.id)).status, 'succeeded');
  await f.ext.commands.get('delegations').handler('', f.ctx);
  assert.equal(f.choices.length, 2); assert.ok(f.notices.some(s => s.includes('Session:')));
  assert.equal(await f.hook('before_agent_start'), undefined, 'RPC never duplicates host review delivery');
  assert.equal(fs.existsSync(path.join(f.root, task.id, 'notification.json')), false);
});

test('terminal roots use next-turn review reminders; nested JSON child inherits exact parent policy', { skip }, async t => {
  const f = await setup(t); f.ctx.mode = 'tui';
  const first = JSON.parse((await f.call('delegate', { title: 'Terminal task', role: 'tester', prompt: 'Fixture only', mode: f.mode, tools: f.mode.tools })).content[0].text);
  assert.equal(first.delivery, 'nextTurn'); await f.done(first.id);
  const notice = await f.hook('before_agent_start');
  assert.match(notice.message.content, /need parent review/);
  f.setFile(first.sessionPath); f.ctx.mode = 'json'; f.ctx.hasUI = false;
  const nested = JSON.parse((await f.call('delegate', { title: 'Nested task', role: 'tester', prompt: 'Fixture only', mode: f.mode, tools: f.mode.tools })).content[0].text);
  assert.equal(nested.parentTaskId, first.id); assert.equal(nested.delivery, 'nextTurn');
  await assert.rejects(f.call('delegation_control', { id: first.id, action: 'cancel' }), /descendants/);
  await assert.rejects(f.call('delegation_review', { id: first.id, review: 'accepted', evidence: 'Self-review' }), /direct parent/);
  await f.done(nested.id);
  const reviewed = JSON.parse((await f.call('delegation_review', { id: nested.id, review: 'accepted', evidence: 'Checked fixture output and terminal state.' })).content[0].text);
  assert.equal(reviewed.review, 'accepted');
});

test('extension rejects unknown models and unavailable tools without launching anything', { skip }, async t => {
  const f = await setup(t);
  const spec = { title: 'Invalid task', role: 'tester', prompt: 'No launch', mode: f.mode, tools: f.mode.tools };
  await assert.rejects(f.call('delegate', { ...spec, model: 'fake/missing' }), /known provider/);
  await assert.rejects(f.call('delegate', { ...spec, tools: ['unavailable'] }), /unavailable/);
  f.setFile(undefined);
  await assert.rejects(f.call('delegate', spec), /saved parent/);
  assert.deepEqual(S.allIds(f.root), []);
});

test('worker mode guard aborts on mismatch but permits model recovery; unrelated sessions ignore stale worker environment', { skip }, async t => {
  const f = await setup(t);
  const task = JSON.parse((await f.call('delegate', { title: 'Guard task', role: 'tester', prompt: 'Fixture only', mode: f.mode, tools: f.mode.tools })).content[0].text);
  await f.done(task.id);
  process.env.PI_DELEGATION_ID = task.id;
  assert.equal(await f.hook('before_provider_request'), undefined);
  assert.equal(f.aborts(), 0);
  f.setFile(task.sessionPath); f.ctx.mode = 'json';
  await assert.rejects(f.hook('before_provider_request'), /contract/);
  assert.equal(f.aborts(), 1);
  f.setBranch([{ type: 'custom', customType: 'mode-switch', data: { definition: f.mode, sha256: D.modeSha256(f.mode), effectiveTools: f.mode.tools } }]);
  assert.equal(await f.hook('before_provider_request'), undefined);
  await f.hook('message_end', { message: { role: 'assistant', stopReason: 'error' } });
  assert.equal(await f.hook('before_provider_request'), undefined);
  assert.equal(f.aborts(), 1, 'model errors must not cancel Pi retries');
  f.setBranch([]);
  await assert.rejects(f.hook('before_provider_request'), /contract/);
  assert.equal(f.aborts(), 2, 'retries must still enforce the mode contract');
});

test('the parent continues a limited worker on its own session, with another model; workers and strangers cannot', { skip }, async t => {
  const f = await setup(t);
  const task = JSON.parse((await f.call('delegate', { title: 'Limited', role: 'tester', prompt: 'Fixture limit', mode: f.mode, tools: f.mode.tools })).content[0].text);
  const stopped = await f.done(task.id);
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.failure.kind, 'usage-limit');
  const status = JSON.parse((await f.call('delegation_status', { id: task.id })).content[0].text);
  assert.equal(status.failure.kind, 'usage-limit'); assert.equal(status.attempt, 1);
  await assert.rejects(f.call('delegation_resume', { id: task.id, model: 'fake/unknown' }), /exact known/);
  f.setFile(stopped.sessionPath);
  await assert.rejects(f.call('delegation_resume', { id: task.id }), /direct parent/);
  f.setFile(f.file);
  const resumed = JSON.parse((await f.call('delegation_resume', { id: task.id, model: 'fake/other', instructions: 'Go on.' })).content[0].text);
  assert.equal(resumed.attempt, 2); assert.equal(resumed.model, 'fake/other');
  const finished = await f.done(task.id);
  assert.equal(finished.status, 'succeeded', finished.error);
  assert.deepEqual(finished.modelsUsed, ['fake/test', 'fake/other']);
  assert.match(f.notices.at(-1), /attempt 2, fake\/other/);
  await assert.rejects(f.call('delegation_resume', { id: task.id }), /Only failed or lost/);
});
