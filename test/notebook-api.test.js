'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
// The notebook endpoints are thin passthroughs to rat (`doctor`, `ensure`,
// `run --doc`, `cancel --doc`). These tests boot the real server with a
// throwaway HOME (so rat's state and kernels are isolated too) and check
// the contract each endpoint keeps with the page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// One pi conversation rooted in `cwd`, so the server knows its project.
function writeFixtureSession(agent, cwd) {
  const dir = path.join(agent, 'sessions', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chat.jsonl'), [
    { type: 'session', version: 3, id: 'chat', cwd },
    { type: 'message', id: 'p', parentId: null, timestamp: '2026-09-18T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'message', id: 'answer1', parentId: 'p', timestamp: '2026-09-18T12:00:01Z', message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'hi' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  return 'pi:fixture/chat.jsonl';
}

async function bootServer(t, extraEnv = {}, { sessionCwd = null } = {}) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-api-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const fixtureKey = sessionCwd ? writeFixtureSession(agent, sessionCwd) : null;
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  // rat keeps state under the XDG dirs when they are set: point every one
  // of them into the throwaway home so no real kernel is touched.
  const isolated = { ...require('./helpers/home-env.js').homeEnv(home), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state') };
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...isolated, PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try {
      const rows = await (await fetch(base + '/api/sessions')).json();
      up = !fixtureKey || rows.some(r => r.key === fixtureKey);
    } catch {}
    if (!up) await new Promise(r => setTimeout(r, 100));
    if (server.exitCode != null) break;
  }
  assert.ok(up, 'server did not start:\n' + log);
  t.after(async () => {
    // Stop any kernel this isolated HOME started, then the server.
    spawnSync('rat', ['stop', '--all'], { env: { ...process.env, ...isolated }, stdio: 'ignore' });
    server.kill('SIGTERM');
    await new Promise(r => server.on('exit', r));
    // A stopping kernel may still flush its log; retry the removal.
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  return { home, base, post, log: () => log, fixtureKey };
}

function makeProject() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-proj-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "thing"\nversion = "0"\n');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'requirements.txt'), 'mkdocs\n');
  const nb = path.join(repo, 'docs', 'guide.md');
  fs.writeFileSync(nb, '# Guide\n\n```python\nprint(40 + 2)\n```\n');
  return { repo, nb };
}

// rat, new enough for what Chattering asks of it (notebook-addressed runs,
// JSON doctor). An older rat is reported, not failed on.
const ratInstalled = !spawnSync('rat', ['version']).error;
const ratHelp = args => String(spawnSync('rat', [...args, '--help'], { encoding: 'utf8' }).stdout || '');
const haveRat = ratInstalled && /--doc\b/.test(ratHelp(['run'])) && /--json\b/.test(ratHelp(['doctor']));
const ratSkip = !ratInstalled ? 'rat is not installed' : 'the installed rat is older than Chattering needs (run --doc, doctor --json)';

test('doctor and run-cell resolve the notebook, not its folder', { skip: !haveRat && ratSkip }, async t => {
  const { post, base } = await bootServer(t);
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const doctor = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(nb))).json();
  assert.equal(doctor.error, undefined, JSON.stringify(doctor));
  assert.equal(doctor.project, repo, 'docs/requirements.txt must not make docs/ the project');
  assert.equal(doctor.project_package, 'thing');
  assert.equal(doctor.python.kernel, 'py@' + path.basename(repo));
  assert.ok(Array.isArray(doctor.checks) && Array.isArray(doctor.actions), 'arrays, never null');
  assert.equal(doctor.ok, false, 'no venv yet');
  assert.ok(doctor.ratPath);

  const bad = await (await fetch(base + '/api/doc/doctor?doc=/nope.md')).json();
  assert.match(bad.error, /doc/);

  const run = await post('/api/doc/run-cell', { lang: 'python', code: 'print(40 + 2)', doc: nb, runId: 'r1' });
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /42/);
  assert.equal(run.runtime, 'py');
  const noDoc = await post('/api/doc/run-cell', { lang: 'python', code: 'print(1)', cwd: repo });
  assert.match(noDoc.error, /doc/);

  const after = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(nb))).json();
  assert.equal(after.python.kernel_running, true, 'the run started the notebook\u0027s kernel');

  const ensure = await post('/api/doc/ensure', { doc: '/nope.md' });
  assert.match(ensure.error, /doc/);
});

test('cancel-run interrupts the kernel through the same notebook resolution', { skip: !haveRat && ratSkip }, async t => {
  const { post } = await bootServer(t);
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const warm = await post('/api/doc/run-cell', { lang: 'py', code: 'x = 1', doc: nb, runId: 'w' });
  assert.equal(warm.code, 0, warm.out);
  const running = post('/api/doc/run-cell', { lang: 'py', code: 'import time\nfor i in range(60): time.sleep(1)', doc: nb, runId: 'slow' });
  await new Promise(r => setTimeout(r, 1500));
  const cancel = await post('/api/doc/cancel-run', { runId: 'slow' });
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.match(result.out, /cancelled/);
  const alive = await post('/api/doc/run-cell', { lang: 'py', code: 'print(x)', doc: nb, runId: 'after' });
  assert.match(alive.out, /1/, 'variables survive an interrupt');
  const gone = await post('/api/doc/cancel-run', { runId: 'slow' });
  assert.match(gone.error, /no such run/);
});

test('a missing rat is reported once, plainly, not as a per-cell mystery', async t => {
  const { post, base } = await bootServer(t, { RAT_BIN: '/definitely/not/rat', PATH: '/nonexistent' });
  const nb = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-'))), 'a.md');
  fs.writeFileSync(nb, '```python\n1\n```\n');
  const doctor = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(nb))).json();
  assert.equal(doctor.ratMissing, true);
  assert.match(doctor.error, /not installed/);
  const run = await post('/api/doc/run-cell', { lang: 'python', code: '1', doc: nb });
  assert.equal(run.missing, true);
  assert.equal(run.code, -1);
  const ensure = await post('/api/doc/ensure', { doc: nb });
  assert.equal(ensure.ratMissing, true);
});

test('notebooks list reads provenance from disk; prerequisites run through rat play', { skip: !haveRat && ratSkip }, async t => {
  const { repo } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // rat's own ipython/jedi additions would need the network; the chain
  // itself needs no packages.
  const { post, base, fixtureKey } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' }, { sessionCwd: repo });
  const dir = path.join(repo, 'documents', 'notebooks');
  fs.mkdirSync(dir, { recursive: true });
  const first = path.join(dir, '2026-09-18-base.md');
  const second = path.join(dir, '2026-09-18-use.md');
  fs.writeFileSync(first, '---\ntitle: Base\nrat:\n  project: ../..\nsource:\n  conversation: "' + fixtureKey + '"\n  entry: "answer1"\n---\n# Base\n\n```python\nbase = 40\n```\n');
  fs.writeFileSync(second, '---\ntitle: Use\nrat:\n  project: ../..\n  after:\n    - ./2026-09-18-base.md\nsource:\n  conversation: "' + fixtureKey + '"\n  entry: "answer1"\n---\n# Use\n\n```python\nprint(base + 2)\n```\n');
  fs.writeFileSync(path.join(dir, 'other.md'), '---\ntitle: Other\nsource:\n  conversation: "pi:elsewhere/x.jsonl"\n  entry: "z"\n---\n');

  const list = await (await fetch(base + '/api/doc/notebooks?key=' + encodeURIComponent(fixtureKey))).json();
  assert.equal(list.root, repo);
  assert.deepEqual(list.notebooks.map(n => [n.title, n.entry, n.after]), [['Base', 'answer1', []], ['Use', 'answer1', ['./2026-09-18-base.md']]]);
  const missing = await fetch(base + '/api/doc/notebooks?key=nope');
  assert.equal(missing.status, 404);

  const doctor = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(second))).json();
  assert.deepEqual(doctor.after.map(a => [path.basename(a.path), a.played]), [['2026-09-18-base.md', false]]);

  const played = await post('/api/doc/play-prerequisites', { doc: second });
  assert.equal(played.ok, true, JSON.stringify(played));
  assert.deepEqual(played.runs.map(r => [r.role, r.skipped, r.ok]), [['prerequisite', false, true]]);
  const after = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(second))).json();
  assert.equal(after.after[0].played, true, 'the kernel remembers the prerequisite');
  const run = await post('/api/doc/run-cell', { lang: 'python', code: 'print(base + 2)', doc: second, runId: 'r' });
  assert.match(run.out, /42/, 'state from the prerequisite is in the kernel');
  const again = await post('/api/doc/play-prerequisites', { doc: second });
  assert.equal(again.runs[0].skipped, true, 'a second call does not replay');

  const derive = await post('/api/doc/notebook-from-answer', { key: 'nope', entryId: 'x' });
  assert.match(derive.error, /required/);
});

// A streamed run (`rat run --events`): output arrives while the cell runs,
// input prompts are answered from the page, and a page that goes away
// does not leave the kernel waiting on nobody.
const ratBin = process.env.RAT_BIN || 'rat';
const ratStreams = haveRat && /--events\b/.test(String(spawnSync(ratBin, ['run', '--help'], { encoding: 'utf8' }).stdout || ''));

async function streamRun(base, body, onEvent) {
  const res = await fetch(base + '/api/doc/run-cell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal: body.signal });
  assert.match(res.headers.get('content-type'), /ndjson/);
  const reader = res.body.getReader(), dec = new TextDecoder(), events = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      events.push(ev);
      await onEvent?.(ev, events);
    }
  }
  return events;
}

test('a streamed run relays output as it comes and takes answers from the page', { skip: !ratStreams && 'this rat does not stream runs (rat run --events)' }, async t => {
  const { post, base } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const code = 'import getpass, time\nprint("step 1", flush=True)\ntime.sleep(0.5)\nname = input("Your name: ")\npw = getpass.getpass("Password: ")\nprint("hello", name, len(pw))';
  const t0 = Date.now();
  let firstOutputAt = null;
  const events = await streamRun(base, { lang: 'python', code, doc: nb, runId: 's1' }, async ev => {
    if (ev.type === 'output' && firstOutputAt == null) firstOutputAt = Date.now() - t0;
    if (ev.type === 'input_request') {
      const r = await post('/api/doc/run-input', { runId: 's1', text: ev.secret ? 'hunter2' : 'Alice' });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
  });
  const kinds = events.map(e => e.type);
  const asks = events.filter(e => e.type === 'input_request');
  assert.deepEqual(asks.map(a => [a.prompt, a.secret]), [['Your name: ', false], ['Password: ', true]]);
  assert.equal(kinds.at(-1), 'done');
  const done = events.at(-1);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /hello Alice 7/);
  assert.doesNotMatch(JSON.stringify(events), /hunter2/, 'the secret never travels back to the page');
  assert.ok(firstOutputAt < done.ms, 'output arrived before the run ended');

  const none = await post('/api/doc/run-input', { runId: 'nope', text: 'x' });
  assert.match(none.error, /no such run/);
});

test('an answer is refused when nothing waits, and a page that leaves cancels its prompt', { skip: !ratStreams && 'this rat does not stream runs (rat run --events)' }, async t => {
  const { post, base } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const warm = await post('/api/doc/run-cell', { lang: 'py', code: 'kept = 7', doc: nb, runId: 'w' });
  assert.equal(warm.code, 0, warm.out);

  // Not waiting yet: the answer is refused, not queued for a later prompt.
  await streamRun(base, { lang: 'py', code: 'import time\nprint("busy", flush=True)\ntime.sleep(1)', doc: nb, runId: 'b' }, async ev => {
    if (ev.type === 'output') {
      const early = await post('/api/doc/run-input', { runId: 'b', text: 'too soon' });
      assert.equal(early.error, 'the program is not waiting for input');
    }
  });

  // The page goes away while the program waits: rat's stdin closes, the
  // prompt is cancelled, the kernel lives on with its variables.
  const ctrl = new AbortController();
  await streamRun(base, { lang: 'py', code: 'input("anyone? ")', doc: nb, runId: 'gone', signal: ctrl.signal }, ev => {
    if (ev.type === 'input_request') ctrl.abort();
  }).catch(e => assert.equal(e.name, 'AbortError'));
  let after;
  for (let i = 0; i < 50; i++) {
    after = await post('/api/doc/run-cell', { lang: 'py', code: 'print(kept)', doc: nb, runId: 'a' + i });
    if (after.code === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /^7$/m, 'the kernel kept its variables');
});

// Kernel controls and variables: state and variables are read without
// ever starting a kernel; reset/restart/stop act on the notebook's kernel.
test('the notebook kernel: state, variables, clear, restart, shut down', { skip: !haveRat && ratSkip }, async t => {
  const { post, base } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const get = (p, q) => fetch(base + p + '?' + new URLSearchParams({ doc: nb, ...q })).then(r => r.json());

  const cold = await get('/api/doc/variables');
  assert.equal(cold.running, false, 'looking at variables did not start a kernel');
  assert.equal((await get('/api/doc/kernel')).running, false);

  const warm = await post('/api/doc/run-cell', { lang: 'py', code: 'answer = 42\nname = "Ada"', doc: nb, runId: 'w' });
  assert.equal(warm.code, 0, warm.out);
  const kernel = await get('/api/doc/kernel');
  assert.equal(kernel.running, true);
  assert.equal(kernel.state, 'idle');
  const vars = await get('/api/doc/variables');
  assert.deepEqual(vars.vars.map(v => [v.name, v.type, v.preview]), [['answer', 'int', '42'], ['name', 'str', "'Ada'"]]);
  const one = await get('/api/doc/variables', { at: 'name' });
  assert.match(one.text, /name: str/);

  // While a cell runs: no look (it would wait behind the cell), no reset.
  const slow = post('/api/doc/run-cell', { lang: 'py', code: 'import time\ntime.sleep(2)', doc: nb, runId: 'slow' });
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await get('/api/doc/variables')).busy, true);
  const refused = await post('/api/doc/kernel', { doc: nb, op: 'reset' });
  assert.match(refused.error, /cell is running/);
  await slow;

  const reset = await post('/api/doc/kernel', { doc: nb, op: 'reset' });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.deepEqual((await get('/api/doc/variables')).vars, []);

  await post('/api/doc/run-cell', { lang: 'py', code: 'again = 1', doc: nb, runId: 'a' });
  const restart = await post('/api/doc/kernel', { doc: nb, op: 'restart' });
  assert.equal(restart.ok, true, JSON.stringify(restart));
  assert.equal(restart.kernel.running, true);
  assert.deepEqual((await get('/api/doc/variables')).vars, [], 'a restarted kernel is empty');

  const stop = await post('/api/doc/kernel', { doc: nb, op: 'stop' });
  assert.equal(stop.ok, true, JSON.stringify(stop));
  assert.equal(stop.kernel.running, false);
  assert.match((await post('/api/doc/kernel', { doc: nb, op: 'explode' })).error, /op must be/);
});

// Following a notebook's kernel on the tab's event stream, and plots.
const ratFollows = haveRat && /Follow what happens/.test(String(spawnSync(ratBin, ['--help'], { encoding: 'utf8' }).stdout || ''));

async function openLive(base) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder(), events = [];
  let buf = '', conn = null;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
          if (!data) continue;
          const d = JSON.parse(data);
          if (d.type === 'hello') conn = d.conn;
          events.push(d);
        }
      }
    } catch {}
  })();
  for (let i = 0; i < 100 && !conn; i++) await new Promise(r => setTimeout(r, 50));
  return { conn, events, close: () => { ctrl.abort(); return pump; } };
}
const waitFor = async (cond, what, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(what); };

test('a tab follows its notebook kernel: other clients\u2019 runs arrive, named, as they happen', { skip: !ratFollows && 'this rat has no `rat events`' }, async t => {
  const { post, base, home } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const warm = await post('/api/doc/run-cell', { lang: 'py', code: 'x = 1', doc: nb, runId: 'w' });
  assert.equal(warm.code, 0, warm.out);

  const live = await openLive(base);
  t.after(() => live.close());
  assert.ok(live.conn, 'no hello on the event stream');
  assert.match((await post('/api/doc/follow', { doc: nb, conn: 'not-mine', langs: ['python'] })).error, /no such event stream/);
  const follow = await post('/api/doc/follow', { doc: nb, conn: live.conn, langs: ['python', 'py'] });
  assert.ok(follow.kernels, JSON.stringify(follow));
  assert.equal(follow.kernels.length, 1, JSON.stringify(follow));
  await new Promise(r => setTimeout(r, 1200));

  // An agent runs code in the same kernel from a terminal.
  const env = { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'), RAT_CALLER: "Lilly's agent" };
  const agent = spawnSync(ratBin, ['run', '--doc', nb, 'py', 'import time\nprint("agent step", flush=True)\ntime.sleep(0.4)\nprint("agent done")'], { env, encoding: 'utf8' });
  assert.equal(agent.status, 0, agent.stderr);
  const kev = () => live.events.filter(e => e.type === 'kernel-event').map(e => e.event);
  await waitFor(() => kev().some(e => e.event === 'run_ended' && e.caller === "Lilly's agent"), 'the agent\u2019s run never reached the tab');
  const started = kev().find(e => e.event === 'run_started' && e.caller === "Lilly's agent");
  assert.match(started.code, /agent step/);
  const text = kev().filter(e => e.run_id === started.run_id && e.event === 'run_output').map(e => e.text).join('') + kev().find(e => e.event === 'run_ended' && e.run_id === started.run_id).output;
  assert.match(text, /agent step/);

  // The page's own streamed run says its rat run id, and carries the person's name.
  const res = await fetch(base + '/api/doc/run-cell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'py', code: 'print("mine")', doc: nb, runId: 'own', stream: true }) });
  const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
  const own = lines.find(l => l.type === 'started');
  assert.ok(own && own.ratRunId, JSON.stringify(lines));
  await waitFor(() => kev().some(e => e.event === 'run_started' && e.run_id === own.ratRunId), 'own run not on the stream');
  assert.match(kev().find(e => e.run_id === own.ratRunId).caller, /\(Chattering\)$/);

  // Stop on another client's run: a kernel-wide interrupt.
  const slow = spawnSync(ratBin, ['run', '--doc', nb, 'py', 'pass'], { env, encoding: 'utf8' });
  assert.equal(slow.status, 0);
  assert.equal((await post('/api/doc/kernel', { doc: nb, op: 'cancel' })).ok, true);

  assert.equal((await post('/api/doc/follow', { doc: null, conn: live.conn })).ok, true);
});

test('plots: shown from rat\u2019s plot folder only, kept in the project by content', { skip: !haveRat && ratSkip }, async t => {
  const { post, base, home } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  // Inside home: the page shows document images from home only, so plots
  // are kept only for projects there.
  const repo = path.join(home, 'Projects', 'thing');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "thing"\nversion = "0"\n');
  const nb = path.join(repo, 'docs', 'guide.md');
  fs.writeFileSync(nb, '# Guide\n');
  const outside = makeProject();
  t.after(() => fs.rmSync(outside.repo, { recursive: true, force: true }));
  assert.match((await post('/api/doc/plots', { doc: outside.nb, paths: [] })).error, /outside home/);
  const plotDir = path.join(home, '.cache', 'rat', 'plots');
  fs.mkdirSync(plotDir, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fig = path.join(plotDir, 'fig-1-0.png');
  fs.writeFileSync(fig, png);
  fs.writeFileSync(path.join(plotDir, 'fig-1-1.png'), png);

  const shown = await fetch(base + '/api/doc/plot?path=' + encodeURIComponent(fig));
  assert.equal(shown.headers.get('content-type'), 'image/png');
  for (const bad of [path.join(repo, 'pyproject.toml'), path.join(plotDir, '..', '..', 'x.png'), '/etc/passwd'])
    assert.equal((await fetch(base + '/api/doc/plot?path=' + encodeURIComponent(bad))).status, 404, bad);

  const saved = await post('/api/doc/plots', { doc: nb, paths: [fig, path.join(plotDir, 'fig-1-1.png')] });
  assert.ok(saved.images, JSON.stringify(saved));
  assert.equal(saved.images.length, 2, JSON.stringify(saved));
  assert.equal(saved.images[0].src, saved.images[1].src, 'the same plot is one file');
  assert.match(saved.images[0].src, /^\.\.\/_assets\/generated\/[0-9a-f]{12}\.png$/);
  assert.ok(fs.readFileSync(path.join(path.dirname(nb), saved.images[0].src)).equals(png));
  assert.match((await post('/api/doc/plots', { doc: nb, paths: ['/etc/hostname'] })).error, /not a plot/);
});

test('completion comes from the running kernel, never starts one, never waits behind a cell', { skip: !haveRat && ratSkip }, async t => {
  const { post, base } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cold = await post('/api/doc/complete', { doc: nb, lang: 'python', code: 'pri', cursor: 3 });
  assert.deepEqual(cold, { items: [], reason: 'not running' });
  assert.equal((await (await fetch(base + '/api/doc/kernel?doc=' + encodeURIComponent(nb))).json()).running, false, 'asking for completions started a kernel');

  assert.equal((await post('/api/doc/run-cell', { lang: 'py', code: 'answer_value = 42\nclass Thing:\n    colour = "green"\nthing = Thing()', doc: nb, runId: 'w' })).code, 0);
  const names = async (code, cursor = code.length) => (await post('/api/doc/complete', { doc: nb, lang: 'python', code, cursor })).items.map(i => i.label);
  assert.ok((await names('answer_v')).includes('answer_value'), 'a variable from the namespace');
  assert.ok((await names('thing.col')).includes('colour'), 'an attribute of a live object');
  assert.ok((await names('x = 1\nthing.co\nprint(x)', 'x = 1\nthing.co'.length)).includes('colour'), 'the code before the cursor, in a longer cell');
  const dashed = await post('/api/doc/complete', { doc: nb, lang: 'python', code: '-answer_v', cursor: 9 });
  assert.equal(dashed.reason, undefined, 'code starting with a dash reached rat as code, not as a flag: ' + JSON.stringify(dashed));
  assert.deepEqual((await post('/api/doc/complete', { doc: nb, lang: 'text', code: 'a', cursor: 1 })).items, []);

  const slow = post('/api/doc/run-cell', { lang: 'py', code: 'import time\ntime.sleep(2)', doc: nb, runId: 'slow' });
  await new Promise(r => setTimeout(r, 500));
  const t0 = Date.now();
  assert.deepEqual(await post('/api/doc/complete', { doc: nb, lang: 'python', code: 'answer_v', cursor: 8 }), { items: [], reason: 'busy' });
  assert.ok(Date.now() - t0 < 1000, 'completion waited behind the running cell');
  await slow;
});
