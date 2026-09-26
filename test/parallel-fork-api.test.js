'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { piPackageDir } = require('../pisdk-runtime');

// Real HTTP routing, source queue, native Pi fork, publication, and indexing.
// Only model execution is replaced: each fake agent keeps appending until
// explicitly aborted, so no credentials or provider requests are involved.
test('HTTP fork opens an independent runnable session while its parent keeps writing', { timeout: 30000 }, async t => {
  try { piPackageDir(); } catch { return t.skip('Native Pi package is not installed'); }
  const root = path.join(__dirname, '..');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-fork-api-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const agent = path.join(home, '.pi', 'agent');
  const dir = path.join(agent, 'sessions', 'fixture');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, 'source.jsonl');
  const raw = [
    { type: 'session', version: 3, id: 'fixture', cwd: home },
    { type: 'message', id: 'question', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Question' } },
    { type: 'message', id: 'answer', parentId: 'question', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Saved answer' }] } },
  ].map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(source, raw);
  const preload = path.join(home, 'fake-model.cjs');
  await fs.writeFile(preload, `
if (process.argv[1] === ${JSON.stringify(path.join(root, 'server.js'))}) {
  const fs = require('node:fs');
  const sdk = require(${JSON.stringify(path.join(root, 'pisdk.js'))});
  const active = new Map();
  sdk.piHeadlessRun = (target, options) => {
    let resolve, seq=0;
    let parent=JSON.parse(fs.readFileSync(target.sessionPath,'utf8').trim().split('\\n').at(-1)).id;
    const done=new Promise(r=>resolve=r);
    const timer=setInterval(()=>{
      const id='live-'+(++seq);
      fs.appendFileSync(target.sessionPath,JSON.stringify({type:'custom',id,parentId:parent,timestamp:new Date().toISOString(),customType:'test-heartbeat',data:{seq}})+'\\n');
      parent=id;
    },30);
    const abort=()=>{clearInterval(timer);active.delete(target.sessionPath);resolve();};
    active.set(target.sessionPath,abort);
    options.onEvent({type:'message_start',message:{role:'assistant'}});
    return {done,abort};
  };
  sdk.stopWarmSession=file=>{if(active.has(file))throw Error('attempted to stop an active parent');return false;};
  sdk.stopAllWarmSessions=()=>{for(const abort of active.values())abort();return 0;};
}
`);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
    ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, NODE_OPTIONS: '--require=' + preload,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  const get = async url => {
    const response = await fetch(base + url, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, url + ': ' + response.status); return response.json();
  };
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.ok(response.ok && !result.error, JSON.stringify(result)); return result;
  };
  const key = 'pi:fixture/source.jsonl';
  let indexed = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await get('/api/sessions')).some(s => s.key === key)) { indexed = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(indexed, log);
  const parent = await post('/api/node/send', { id: key, prompt: 'Keep working' });
  for (let i = 0; i < 100 && (await fs.stat(source)).size === Buffer.byteLength(raw); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok((await fs.stat(source)).size > Buffer.byteLength(raw), 'parent did not start writing');
  const fork = await post('/api/fork', { id: key, node: 'answer' });
  assert.notEqual(fork.key, key);
  assert.equal((await get('/api/jobs')).find(j => j.id === parent.job.id).status, 'running');
  assert.ok((await fs.readFile(source, 'utf8')).startsWith(raw), 'fork altered saved source history');
  const forkText = await fs.readFile(fork.path, 'utf8');
  assert.doesNotMatch(forkText, /test-heartbeat/);
  assert.equal(JSON.parse(forkText.split('\n')[0]).parentSession, source);
  const second = await post('/api/node/send', { id: fork.key, prompt: 'Work independently' });
  await new Promise(resolve => setTimeout(resolve, 120));
  const jobs = await get('/api/jobs');
  assert.equal(jobs.find(j => j.id === parent.job.id).status, 'running');
  assert.equal(jobs.find(j => j.id === second.job.id).status, 'running');
  assert.match(await fs.readFile(fork.path, 'utf8'), /test-heartbeat/);
  await post('/api/run/abort', { jobId: second.job.id });
  assert.equal((await get('/api/jobs')).find(j => j.id === parent.job.id).status, 'running');
  const size = (await fs.stat(source)).size;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok((await fs.stat(source)).size > size, 'aborting fork stopped original');
  await post('/api/run/abort', { jobId: parent.job.id });
});
