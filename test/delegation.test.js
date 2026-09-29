'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const D = require('../delegation');
const S = require('../delegation-store');
const { resultParser } = require('../delegation-supervisor');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// explain(): what to add to a timeout's message, so a slow system's failure names its cause.
async function until(fn, timeout = 8000, explain = null) {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('Timed out waiting for fixture' + (explain ? '\n' + await explain() : '')); await sleep(30); }
}
// A task's own account: its state, events, and the tail of its supervisor and worker logs.
function account(root, id) {
  const tail = name => { try { return fs.readFileSync(path.join(root, id, name), 'utf8').slice(-2000) || '(empty)'; } catch { return '(none)'; } };
  return ['state.json', 'events.jsonl', 'supervisor.log', 'stderr.log'].map(name => `--- ${name}\n${tail(name)}`).join('\n');
}
const FAKE = String.raw`
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), arg = k => args[args.indexOf(k)+1];
const file = arg('--session'), mode = JSON.parse(fs.readFileSync(arg('--prompt-mode-file'),'utf8'));
const prompt = fs.readFileSync(args.at(-1).slice(1),'utf8');
const behavior = prompt.startsWith('Your previous attempt') ? 'resumed' : prompt.split('\n')[0];
const S = require(process.env.FIXTURE_STORE);
const append = entry => fs.appendFileSync(file, JSON.stringify(entry)+'\n');
const emit = entry => process.stdout.write(JSON.stringify(entry)+'\n');
S.atomic(path.join(path.dirname(arg('--prompt-mode-file')), 'observed.json'), JSON.stringify({args, cwd:process.cwd(), env:Object.fromEntries(Object.entries(process.env).filter(([k]) => /^PI_(PROMPT|EFFECTIVE|SESSION|ORCHESTRATOR|DELEGATION)/.test(k)))}));
if(behavior !== 'missing-mode' && behavior !== 'resumed') append({type:'custom',id:'mode1',parentId:null,customType:'mode-switch',data:{version:1,mode:mode.key,definition:mode,sha256:behavior === 'bad-mode' ? 'wrong' : S.sha256(mode),effectiveTools:behavior === 'bad-tools' ? ['write'] : mode.tools}});
if(behavior === 'resumed') {
  const lines = fs.readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const leaf = lines.filter(e=>e.type!=='session').at(-1);
  const [provider, model] = arg('--model').split('/');
  append({type:'custom',id:'mode-again',parentId:leaf?leaf.id:null,customType:'mode-switch',data:{version:1,mode:mode.key,definition:mode,sha256:S.sha256(mode),effectiveTools:mode.tools}});
  const message={role:'assistant',provider,model,stopReason:'stop',content:[{type:'text',text:'resumed after: '+prompt.split('\n')[0]}]};
  append({type:'message',id:'resumed-'+arg('--thinking'),parentId:'mode-again',message});
  emit({type:'message_end',message}); emit({type:'agent_end',messages:[message]});
} else if(behavior === 'error') {
  const message={role:'assistant',provider:'fake',model:'test',stopReason:'error',errorMessage:'fixture model quota error',content:[]};
  append({type:'message',id:'answer',message}); emit({type:'message_end',message});
  emit({type:'agent_end',messages:[message]});
} else if(behavior === 'recover' || behavior === 'exhausted' || behavior === 'retry-wait') {
  const failed={role:'assistant',provider:'fake',model:'test',stopReason:'error',errorMessage:'terminated',content:[]};
  append({type:'message',id:'attempt1',message:failed}); emit({type:'message_end',message:failed});
  emit({type:'auto_retry_start',attempt:1,maxAttempts:1,delayMs:100});
  setTimeout(()=>{
    if(behavior === 'exhausted') {
      emit({type:'auto_retry_end',success:false,attempt:1,finalError:'retry budget exhausted'});
      emit({type:'agent_end',messages:[failed]});
    } else {
      const message={role:'assistant',provider:'fake',model:'test',stopReason:'stop',content:[{type:'text',text:'recovered'}]};
      append({type:'message',id:'recovered',message});
      emit({type:'message_end',message}); emit({type:'auto_retry_end',success:true,attempt:1});
      emit({type:'agent_end',messages:[failed,message],padding:'x'.repeat(256*1024)});
    }
  },behavior === 'retry-wait' ? 20000 : 100);
} else if(behavior === 'empty') { process.exit(0); }
else if(behavior === 'nonzero') { process.stderr.write('fixture exit error\n');process.exit(7); }
else {
  if(behavior === 'changed-snapshot') fs.writeFileSync(arg('--prompt-mode-file'),JSON.stringify({...mode,opener:'Changed'}));
  if(behavior === 'stubborn') process.on('SIGTERM',()=>{});
  if(behavior === 'process-tree') {
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    S.atomic(path.join(path.dirname(arg('--prompt-mode-file')),'process-child.json'),JSON.stringify(S.identity(child.pid)));
  }
  if(behavior === 'noise') process.stdout.write('x'.repeat(2*1024*1024)+'\n');
  if(behavior === 'nested') {
    const D = require(process.env.FIXTURE_RUNNER);
    D.launchDelegation({title:'Nested child',role:'helper',prompt:'wait',model:'fake/test',tools:mode.tools,mode,cwd:process.cwd(),parentSessionPath:file,parentEntryId:'mode1',delivery:'nextTurn'}, {root:process.env.PI_DELEGATION_ROOT,piExecutable:process.execPath,piArgs:[__filename],supervision:'detached'}).then(t=>S.atomic(path.join(path.dirname(arg('--prompt-mode-file')),'nested.json'),JSON.stringify(t)));
  }
  // hold: runs until the test writes 'release' in the task folder, then ends by itself.
  if(behavior === 'hold') setInterval(()=>{ if(fs.existsSync(path.join(path.dirname(arg('--prompt-mode-file')),'release'))) process.exit(0); },50);
  const delay = ['wait','stubborn','nested','process-tree'].includes(behavior) ? 20000 : behavior === 'hold' ? 600000 : behavior === 'short-wait' ? 700 : 30;
  setTimeout(()=>{
    const message={role:'assistant',provider:'fake',model:behavior === 'bad-model'?'other':'test',stopReason:behavior === 'length'?'length':'stop',content:[{type:'text',text:'fixture completed ☃'}]};
    append({type:'message',id:'answer',parentId:'mode1',message});
    emit({type:'message_end',message});emit({type:'agent_end',messages:[message]});
    process.stderr.write('fixture stderr\n');
  },delay);
}
`;
async function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-test-')));
  const root = path.join(dir, 'store'), parent = path.join(dir, 'parent.jsonl'), fake = path.join(dir, 'fake-pi.cjs');
  fs.writeFileSync(parent, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: dir }) + '\n');
  fs.writeFileSync(fake, FAKE);
  const mode = { key: 'fixture', label: 'Fixture', opener: 'Test only.', tools: ['read', 'delegate'] };
  const options = { root, supervision: 'detached', piExecutable: process.execPath, piArgs: [fake], env: { ...process.env,
    FIXTURE_STORE: require.resolve('../delegation-store'), FIXTURE_RUNNER: require.resolve('../delegation'),
    PI_PROMPT_MODE: 'stale', PI_EFFECTIVE_PROMPT_MODE: 'stale', PI_SESSION_FILE: '/stale', PI_ORCHESTRATOR_INBOX: '/stale' } };
  const spec = { title: 'Fixture task', role: 'tester', prompt: 'success', model: 'fake/test', thinking: 'off', tools: mode.tools, mode,
    cwd: dir, parentSessionPath: parent, parentEntryId: 'parent-entry' };
  t.after(async () => {
    for (const id of S.allIds(root)) {
      const task = await D.getDelegation(id, options);
      if (!S.TERMINAL.has(task.status)) await D.controlDelegation(id, 'cancel', options);
    }
    await until(async () => (await D.listDelegations(options)).every(t => S.TERMINAL.has(t.status)));
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, root, parent, fake, mode, options, spec, launch: patch => D.launchDelegation({ ...spec, ...patch }, options),
    // A worker's whole run: up to thirty seconds on a slow machine, with the task's account on failure.
    done: id => until(async () => { const task = await D.getDelegation(id, options); return S.TERMINAL.has(task.status) ? task : null; }, 30000, () => account(root, id)) };
}

test('preflight rejects invalid cwd, model, mode, tool mismatch, parent and delivery before persistence', async t => {
  const f = await fixture(t);
  for (const patch of [{ cwd: '/definitely/missing' }, { cwd: f.parent }, { model: 'guess' }, { model: 'fake/*' },
    { mode: { ...f.mode, surprise: true } }, { tools: ['write'] }, { mode: { ...f.mode, tools: undefined } },
    { tools: ['read', 'read'] }, { parentSessionPath: 'relative.jsonl' }, { delivery: 'inbox' }, { parentTaskId: randomUUID() }]) {
    await assert.rejects(f.launch(patch));
  }
  assert.deepEqual(S.allIds(f.root), []);
});

test('detached supervisor persists exact argv, independent session, results and sanitized environment', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'short-wait' });
  // Launch does not wait for the worker: it answers while the work is still
  // under way (this worker takes 0.7 s). Shown by the state, not a clock.
  assert.ok(['starting', 'running'].includes(task.status), 'launch must not wait for worker completion: ' + task.status);
  assert.equal(task.parentTaskId, null);
  const done = await f.done(task.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.review, 'unreviewed');
  assert.equal(done.delivery, 'nextTurn');
  assert.equal(done.modeVerification.sha256, D.modeSha256(f.mode));
  assert.equal(done.result.summary, 'fixture completed ☃');
  const observed = S.readJson(path.join(f.root, task.id, 'observed.json'));
  assert.equal(observed.cwd, f.dir);
  assert.deepEqual(observed.args.slice(0, 4), ['--mode', 'json', '--session', task.sessionPath]);
  assert.equal(observed.args.at(-2), '-p'); assert.equal(observed.args.at(-1), '@' + task.promptPath);
  assert.ok(observed.args.includes(path.resolve(__dirname, '../extensions/delegation.ts')));
  assert.equal(observed.env.PI_DELEGATION_ID, task.id);
  assert.equal(observed.env.PI_PROMPT_MODE, undefined);
  assert.equal(observed.env.PI_SESSION_FILE, undefined);
  assert.equal(observed.env.PI_ORCHESTRATOR_INBOX, undefined);
  const header = JSON.parse(fs.readFileSync(task.sessionPath, 'utf8').split('\n')[0]);
  assert.equal(header.cwd, f.dir); assert.equal(header.parentSession, undefined);
  assert.ok(fs.readFileSync(task.logPath, 'utf8').includes('message_end'));
  assert.equal(fs.readFileSync(task.stderrPath, 'utf8'), 'fixture stderr\n');
  assert.ok(fs.readFileSync(task.eventLogPath, 'utf8').includes('succeeded'));
});

// The one-command install puts no modes extension in pi's folder, and --prompt-mode-file is that
// extension's flag: without it pi exits at once. The worker then loads Chattering's copy; a pi that has
// its own keeps it alone (the flag must not be defined twice).
test('workers load the modes extension exactly when pi does not have its own', async t => {
  const f = await fixture(t);
  const bundled = path.join(__dirname, '..', 'extensions', 'modes.ts');
  const argsOf = async (agentDir) => {
    const opts = { ...f.options, env: { ...f.options.env, PI_CODING_AGENT_DIR: agentDir } };
    const task = await D.launchDelegation({ ...f.spec, prompt: 'success' }, opts);
    await f.done(task.id);
    return S.readJson(path.join(f.root, task.id, 'launch.json')).args;
  };
  const bare = path.join(f.dir, 'bare-agent'), own = path.join(f.dir, 'own-agent');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(path.join(own, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(own, 'extensions', 'modes.ts'), '// the person\'s own');
  const loaded = args => args.filter((a, i) => args[i - 1] === '-e');
  assert.ok(loaded(await argsOf(bare)).includes(bundled), 'fresh pi: Chattering\'s modes extension is loaded');
  assert.ok(!loaded(await argsOf(own)).includes(bundled), 'pi with its own modes extension: not loaded twice');
});

test('zero exit does not hide model errors, missing results, mode mismatch or truncation', async t => {
  const f = await fixture(t);
  for (const behavior of ['error', 'empty', 'bad-mode', 'missing-mode', 'bad-tools', 'bad-model', 'changed-snapshot', 'length', 'noise', 'nonzero']) {
    const task = await f.launch({ prompt: behavior });
    const done = await f.done(task.id);
    assert.equal(done.status, 'failed', behavior);
    assert.equal(done.review, 'unreviewed');
    assert.ok(done.error, behavior);
    if (behavior === 'error') assert.match(done.error, /quota error/);
    if (behavior === 'noise') assert.ok(fs.statSync(done.logPath).size > 2 * 1024 * 1024, 'raw output remains complete');
  }
  // The worker owns its retry policy; a terminal model error still fails.
});

test('model retries recover without signals and preserve the final large output record', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'recover' });
  const done = await f.done(task.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.summary, 'recovered');
  assert.equal(done.result.parseProblems, 0);
  const records = fs.readFileSync(done.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.at(-1).padding.length, 256 * 1024);
  const events = fs.readFileSync(done.eventLogPath, 'utf8');
  assert.match(events, /auto_retry_start/);
  assert.match(events, /auto_retry_end/);
  assert.doesNotMatch(events, /failure-signalled|failure-kill/);
});

test('exhausted retries preserve the final failure without stopping the worker', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'exhausted' });
  const done = await f.done(task.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'retry budget exhausted');
  assert.equal(done.exitCode, 0);
  assert.equal(done.result.parseProblems, 0);
});

test('user cancellation still stops a worker waiting to retry', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'retry-wait' });
  await until(() => fs.readFileSync(task.eventLogPath, 'utf8').includes('auto_retry_start'));
  await D.controlDelegation(task.id, 'cancel', f.options);
  const done = await f.done(task.id);
  assert.equal(done.status, 'cancelled');
  assert.match(fs.readFileSync(task.eventLogPath, 'utf8'), /cancel-signalled/);
});

test('oversize duplicate run aggregates stay bounded without hiding missing or corrupt messages', () => {
  const aggregate = JSON.stringify({ type: 'agent_end', messages: [], padding: 'x'.repeat(2 * 1024 * 1024) }) + '\n';
  const emit = (p, value) => p.push(JSON.stringify(value) + '\n');
  const message = { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } };
  const p = resultParser('fake/test');
  emit(p, message);
  for (let i = 0; i < aggregate.length; i += 8192) p.push(aggregate.slice(i, i + 8192));
  p.end();
  assert.equal(p.result.summary, 'done');
  assert.equal(p.result.parseProblems, 0);
  assert.equal(p.result.skippedAggregateRecords, 1);
  const legacy = resultParser('fake/test'); legacy.push(aggregate); legacy.end();
  assert.equal(legacy.result.parseProblems, 1, 'aggregate-only printers need a verifiable result');
  emit(p, { type: 'message_end', padding: 'x'.repeat(2 * 1024 * 1024) });
  p.push('{broken\n');
  assert.equal(p.result.parseProblems, 2, 'individual and malformed records remain failures');
});

test('legacy agent_end-only printers can recover on later turns', () => {
  const parsed = resultParser('fake/test');
  for (const message of [
    { role: 'assistant', stopReason: 'error', errorMessage: 'terminated', content: [] },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }] },
  ]) parsed.push(JSON.stringify({ type: 'agent_end', messages: [message] }) + '\n');
  assert.equal(parsed.result.error, null);
  assert.equal(parsed.result.summary, 'recovered');
});

test('attempt errors recover but extension failures remain fatal', () => {
  let stops = 0;
  const parsed = resultParser('fake/test', () => stops++);
  const emit = event => parsed.push(JSON.stringify(event) + '\n');
  const message = (stopReason, content = [], errorMessage) => emit({ type: 'message_end', message: {
    role: 'assistant', provider: 'fake', model: 'test', stopReason, content, errorMessage,
  } });
  message('error', [], 'terminated');
  assert.equal(stops, 0);
  message('stop', [{ type: 'text', text: 'recovered' }]);
  assert.equal(parsed.result.error, null);
  emit({ type: 'extension_error', error: 'broken extension' });
  message('stop', [{ type: 'text', text: 'later message' }]);
  assert.equal(stops, 1);
  assert.match(parsed.result.fatalError, /broken extension/);
});

test('worker executable start errors become durable failed records', async t => {
  const f = await fixture(t);
  const task = await D.launchDelegation(f.spec, { ...f.options, piExecutable: path.join(f.dir, 'missing-pi') });
  const done = await f.done(task.id);
  assert.equal(done.status, 'failed'); assert.match(done.error, /launch failed/);
  assert.ok(fs.existsSync(done.promptPath));
});

test('pause blocks descendants; resume does not undo durable subtree cancellation; recursive delivery uses exact parent', async t => {
  const f = await fixture(t);
  const parent = await f.launch({ prompt: 'nested', delivery: 'web' });
  const nested = await until(() => S.readJson(path.join(f.root, parent.id, 'nested.json'), null), 8000, () => account(f.root, parent.id));
  assert.equal(nested.parentTaskId, parent.id);
  assert.equal(nested.parentSessionPath, parent.sessionPath);
  assert.equal(nested.delivery, 'web', 'JSON child inherits parent web policy');
  const childSpec = { ...f.spec, parentSessionPath: nested.sessionPath, parentEntryId: 'mode1', delivery: 'none', prompt: 'wait' };
  await D.controlDelegation(parent.id, 'pause', f.options);
  assert.equal((await D.getDelegation(nested.id, f.options)).paused, true);
  // Paused is not stopped: the parent keeps running (once its supervisor has recorded the start).
  await until(async () => (await D.getDelegation(parent.id, f.options)).status === 'running', 8000, () => account(f.root, parent.id));
  await assert.rejects(D.launchDelegation(childSpec, f.options), /paused/);
  await D.controlDelegation(parent.id, 'resume', f.options);
  const grandchild = await D.launchDelegation(childSpec, f.options);
  assert.equal(grandchild.parentTaskId, nested.id); assert.equal(grandchild.delivery, 'web');
  await D.controlDelegation(parent.id, 'cancel', f.options);
  await D.controlDelegation(parent.id, 'resume', f.options);
  await assert.rejects(D.launchDelegation(childSpec, f.options), /cancelled/);
  for (const id of [parent.id, nested.id, grandchild.id]) assert.equal((await f.done(id)).status, 'cancelled');
});

test('cancel concurrent with launch leaves no running subtree; stubborn owned process receives SIGKILL', async t => {
  const f = await fixture(t);
  const parent = await f.launch({ prompt: 'stubborn' });
  await until(() => fs.existsSync(path.join(f.root, parent.id, 'observed.json')));
  const launches = Array.from({ length: 5 }, () => D.launchDelegation({ ...f.spec, prompt: 'wait', parentSessionPath: parent.sessionPath, parentEntryId: 'mode1' }, f.options));
  await D.controlDelegation(parent.id, 'cancel', f.options);
  const children = await Promise.all(launches);
  for (const task of [parent, ...children]) assert.equal((await f.done(task.id)).status, 'cancelled');
  const events = fs.readFileSync(parent.eventLogPath, 'utf8');
  // Unix asks first (SIGTERM, which this worker ignores), then kills. Windows
  // has no polite stop for console programs: the first stop is already final.
  if (process.platform === 'win32') assert.match(events, /"type":"cancel-signalled","signalled":true/);
  else assert.match(events, /cancel-kill/);
});

test('cancellation signals the owned worker process group, including ordinary tool children', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'process-tree' });
  const child = await until(() => S.readJson(path.join(f.root, task.id, 'process-child.json'), null));
  assert.ok(S.sameProcess(child));
  await D.controlDelegation(task.id, 'cancel', f.options);
  assert.equal((await f.done(task.id)).status, 'cancelled');
  await until(() => !S.sameProcess(child));
});

test('caller process exit does not stop detached workers; new caller reads completion', async t => {
  const f = await fixture(t);
  const launcher = spawn(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../delegation'))}).launchDelegation(${JSON.stringify({ ...f.spec, prompt: 'short-wait' })}, ${JSON.stringify(f.options)}).then(t => console.log(t.id))`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; launcher.stdout.on('data', c => { output += c; }); launcher.stderr.on('data', c => { errors += c; });
  assert.equal(await new Promise(resolve => launcher.on('close', resolve)), 0, errors);
  const id = output.trim(); assert.match(id, S.ID);
  assert.equal((await f.done(id)).status, 'succeeded');
});

test('dead supervisor becomes lost and never fabricates success or kills an orphan', async t => {
  const f = await fixture(t);
  // A worker that outlives every check here, however slow the machine, until released.
  const task = await f.launch({ prompt: 'hold' });
  const running = await until(async () => { const r = await D.getDelegation(task.id, f.options); return r.status === 'running' && fs.existsSync(path.join(f.root, task.id, 'observed.json')) ? r : null; }, 8000, () => 'the worker to run\n' + account(f.root, task.id));
  assert.ok(S.sameProcess(running.supervisorIdentity));
  process.kill(running.supervisorPid, 'SIGKILL');
  await until(() => !S.sameProcess(running.supervisorIdentity), 8000, () => 'the supervisor to end\n' + account(f.root, task.id));
  const lost = await D.getDelegation(task.id, f.options);
  assert.equal(lost.status, 'lost');
  assert.ok(S.sameProcess(running.processIdentity), 'reconciliation does not kill orphan worker');
  await D.controlDelegation(task.id, 'cancel', f.options);
  assert.equal((await D.getDelegation(task.id, f.options)).status, 'lost');
  // Nothing signals a saved PID, not even a cancel: the orphan ends by itself.
  assert.ok(S.sameProcess(running.processIdentity), 'cancelling lost work does not kill the orphan by saved PID');
  fs.writeFileSync(path.join(f.root, task.id, 'release'), '');
  await until(() => !S.sameProcess(running.processIdentity), 8000, () => 'the released worker to end\n' + account(f.root, task.id));
  assert.equal((await D.getDelegation(task.id, f.options)).status, 'lost');
});

test('review requires terminal state, exact parent identity and evidence; attempts keep separate artifacts', async t => {
  const f = await fixture(t);
  const first = await f.launch({}); await f.done(first.id);
  await assert.rejects(D.reportDelegationReview(first.id, 'accepted', '', { ...f.options, reviewerSessionPath: f.parent }));
  await assert.rejects(D.reportDelegationReview(first.id, 'accepted', 'Looked at tests', { ...f.options, reviewerSessionPath: first.sessionPath }), /exact parent/);
  const reviewed = await D.reportDelegationReview(first.id, 'accepted', 'Read fixture output and tests', { ...f.options, reviewerSessionPath: f.parent });
  assert.equal(reviewed.review, 'accepted'); assert.equal(reviewed.status, 'succeeded');
  const retry = await f.launch({ retryOf: first.id });
  assert.notEqual(first.id, retry.id); assert.notEqual(first.outputDir, retry.outputDir); assert.equal(retry.retryOf, first.id);
  assert.ok(fs.existsSync(first.promptPath));
});

test('listing bounds old terminal records, retains live tasks, and distrusts reused supervisor PIDs', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-list-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = S.identity(process.pid);
  const ids = [];
  for (let i = 0; i < 2005; i++) {
    const id = randomUUID(), dir = path.join(root, id); ids.push(id); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ version: 1, id, parentTaskId: null,
      status: i === 0 ? 'running' : 'succeeded', createdAt: i, updatedAt: i, review: 'unreviewed' }));
    if (i === 0) fs.writeFileSync(path.join(dir, 'supervisor.json'), JSON.stringify(owner));
  }
  const listed = await D.listDelegations({ root });
  assert.equal(listed.length, 2000); assert.equal(listed.listing.omitted, 5);
  assert.ok(listed.some(t => t.id === ids[0]), 'old live task must not be discarded');
  fs.writeFileSync(path.join(root, ids[0], 'supervisor.json'), JSON.stringify({ ...owner, start: 'reused' }));
  assert.equal((await D.getDelegation(ids[0], { root })).status, 'lost');
  await D.controlDelegation(ids[0], 'cancel', { root });
  assert.equal(S.sameProcess(owner), true, 'saved process identity never authorizes cancellation');
});

test('bounded parser handles split UTF-8, LF framing and a huge unterminated record', () => {
  const parsed = resultParser('fake/test');
  const text = JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', provider: 'fake', model: 'test', content: [{ type: 'text', text: '☃\u2028snow' }] } });
  const bytes = Buffer.from(text + '\n');
  for (const byte of bytes) parsed.push(Buffer.from([byte]));
  assert.equal(parsed.result.summary, '☃\u2028snow');
  for (let i = 0; i < 50; i++) parsed.push(Buffer.alloc(65536, 120));
  parsed.push('\n' + text); parsed.end();
  assert.equal(parsed.result.parseProblems, 1); assert.equal(parsed.result.stopReason, 'stop');
  assert.equal(S.sameProcess({ ...S.identity(process.pid), start: 'wrong' }), false);
});

test('a stopped worker continues on its own session; the record keeps every attempt', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'error' });
  const failed = await f.done(task.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, { kind: 'usage-limit', message: 'fixture model quota error', resumable: true });
  assert.equal(failed.attempt, 1);
  assert.equal(failed.leafId, 'answer');
  const resumed = await D.resumeDelegation(task.id, { instructions: 'Finish the fixture.' }, f.options);
  assert.ok(['starting', 'running'].includes(resumed.status));
  assert.equal(resumed.attempt, 2);
  const done = await f.done(task.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.attempt, 2);
  assert.equal(done.model, 'fake/test');
  assert.equal(done.result.summary, 'resumed after: Your previous attempt on this task stopped. Reason: usage-limit: fixture model quota error');
  assert.equal(done.resumes.length, 1);
  assert.equal(done.resumes[0].previousStatus, 'failed');
  assert.equal(done.resumes[0].previousFailure.kind, 'usage-limit');
  assert.equal(done.sessionPath, failed.sessionPath);
  const entries = fs.readFileSync(task.sessionPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(entries.filter(e => e.type !== 'session').map(e => e.id), ['mode1', 'answer', 'mode-again', 'resumed-off']);
  assert.equal(S.readJson(path.join(f.root, task.id, 'request.json')).model, 'fake/test');
  const resumePrompt = fs.readFileSync(path.join(f.root, task.id, 'resume-1.md'), 'utf8');
  assert.match(resumePrompt, /inspect the working tree and your output directory/);
  assert.match(resumePrompt, /Finish the fixture\./);
  assert.ok(fs.existsSync(path.join(f.root, task.id, 'supervisor-1.json')), 'previous supervisor claim is kept as history');
  const events = fs.readFileSync(task.eventLogPath, 'utf8');
  assert.match(events, /"type":"failed".*"failure":"usage-limit"/);
  assert.match(events, /resume-requested/);
  assert.match(events, /"type":"succeeded"/);
  // Both attempts left their stdout in one log.
  assert.equal((fs.readFileSync(task.logPath, 'utf8').match(/message_end/g) || []).length, 2);
  await assert.rejects(D.resumeDelegation(task.id, {}, f.options), /Only failed or lost/);
});

test('continuing with another model or reasoning level changes only the next attempt', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'error' });
  await f.done(task.id);
  await assert.rejects(D.resumeDelegation(task.id, { model: 'fake/*' }, f.options), /exact provider\/model/);
  await assert.rejects(D.resumeDelegation(task.id, { thinking: 'ultra' }, f.options), /thinking/);
  await assert.rejects(D.resumeDelegation(task.id, { parentSessionPath: task.sessionPath }, f.options), /exact parent/);
  const resumed = await D.resumeDelegation(task.id, { model: 'fake/other', thinking: 'high', parentSessionPath: f.parent }, f.options);
  assert.equal(resumed.model, 'fake/other'); assert.equal(resumed.thinking, 'high');
  const done = await f.done(task.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(done.modelsUsed, ['fake/test', 'fake/other']);
  assert.match(fs.readFileSync(path.join(f.root, task.id, 'resume-1.md'), 'utf8'), /You now run as fake\/other; earlier messages came from fake\/test/);
  const observed = S.readJson(path.join(f.root, task.id, 'observed.json'));
  assert.equal(observed.args[observed.args.indexOf('--model') + 1], 'fake/other');
  assert.equal(observed.args[observed.args.indexOf('--thinking') + 1], 'high');
  assert.equal(observed.args.at(-1), '@' + path.join(f.root, task.id, 'resume-1.md'));
  assert.equal(S.readJson(path.join(f.root, task.id, 'request.json')).model, 'fake/test');
});

test('lost work continues after its supervisor vanished; refusals name the reason', async t => {
  const f = await fixture(t);
  const task = await f.launch({ prompt: 'hold' });
  const running = await until(async () => { const r = await D.getDelegation(task.id, f.options); return r.status === 'running' && fs.existsSync(path.join(f.root, task.id, 'observed.json')) ? r : null; }, 8000, () => 'the worker to run\n' + account(f.root, task.id));
  process.kill(running.supervisorPid, 'SIGKILL');
  await until(() => !S.sameProcess(running.supervisorIdentity), 8000, () => 'the supervisor to end\n' + account(f.root, task.id));
  const lost = await D.getDelegation(task.id, f.options);
  assert.equal(lost.status, 'lost'); assert.equal(lost.failure.kind, 'interrupted');
  await assert.rejects(D.resumeDelegation(task.id, {}, f.options), /still alive/);
  fs.writeFileSync(path.join(f.root, task.id, 'release'), '');
  await until(() => !S.sameProcess(running.processIdentity), 8000, () => 'the released worker to end\n' + account(f.root, task.id));
  const resumed = await D.resumeDelegation(task.id, {}, f.options);
  assert.equal(resumed.attempt, 2);
  assert.ok(['starting', 'running', 'succeeded'].includes(resumed.status), resumed.status);
  const done = await f.done(task.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.ok(fs.existsSync(path.join(f.root, task.id, 'lost-1.json')));

  const good = await f.launch({});
  await f.done(good.id);
  await assert.rejects(D.resumeDelegation(good.id, {}, f.options), /Only failed or lost/);

  const cancelled = await f.launch({ prompt: 'error' });
  await f.done(cancelled.id);
  await D.controlDelegation(cancelled.id, 'cancel', f.options);
  await assert.rejects(D.resumeDelegation(cancelled.id, {}, f.options), /cancelled/);

  const paused = await f.launch({ prompt: 'error' });
  await f.done(paused.id);
  await D.controlDelegation(paused.id, 'pause', f.options);
  await assert.rejects(D.resumeDelegation(paused.id, {}, f.options), /paused/);

  const taken = await f.launch({ prompt: 'error' });
  await f.done(taken.id);
  const marked = await D.markDelegationTakeover(taken.id, { model: 'fake/human' }, f.options);
  assert.equal(marked.takenOver.model, 'fake/human');
  await assert.rejects(D.resumeDelegation(taken.id, {}, f.options), /continued this conversation by hand/);

  const moved = await f.launch({ prompt: 'error' });
  await f.done(moved.id);
  fs.appendFileSync(moved.sessionPath, JSON.stringify({ type: 'message', id: 'human-edit', parentId: 'answer', message: { role: 'user', content: 'hi' } }) + '\n');
  await assert.rejects(D.resumeDelegation(moved.id, {}, f.options), /session changed/);
});

test('failure classification names the stop reason and keeps the raw message', () => {
  const c = S.classifyFailure;
  assert.equal(c('Claude Code request failed (429): {"type":"rate_limit_error"}').kind, 'usage-limit');
  assert.equal(c("You've hit your limit · resets 3pm").kind, 'usage-limit');
  assert.equal(c('insufficient_quota').kind, 'usage-limit');
  assert.equal(c('Codex error: Our servers are currently overloaded. Please try again later.').kind, 'overload');
  assert.equal(c('Request was aborted').kind, 'overload');
  assert.equal(c('prompt is too long: 213462 tokens > 200000 maximum').kind, 'context-overflow');
  assert.equal(c('Your input exceeds the context window of this model').kind, 'context-overflow');
  assert.equal(c('ThrottlingException: Too many tokens, please wait').kind, 'usage-limit');
  assert.equal(c('Worker exited with SIGTERM').kind, 'interrupted');
  assert.equal(c('Worker exited with 137', { exitSignal: 'SIGKILL' }).kind, 'interrupted');
  assert.equal(c('401 Unauthorized').kind, 'auth');
  assert.equal(c('Pi used a model other than the exact requested model').kind, 'contract');
  assert.equal(c('Delegated mode contract does not match the saved mode or active tools.').kind, 'contract');
  assert.equal(c('Delegated mode contract does not match').resumable, false);
  assert.equal(c('something odd').kind, 'unknown');
  assert.equal(c('something odd').resumable, true);
  assert.equal(c('x'.repeat(5000)).message.length, 2000);
});
