'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process');
const fixtureChild = require('./title-fixture-child.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label = 'fixture condition', timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fixtureChild.within(Promise.resolve().then(fn), deadline - Date.now())
      .catch(error => { throw new Error('Timed out or failed: ' + label + ': ' + error.message); });
    if (value) return value;
    await sleep(Math.min(40, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Timed out: ' + label);
}
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function boot(t, options = {}) {
  // Native canonicalization expands Windows 8.3 temp names before fs.watch
  // receives them; libuv's event prefix assertion requires the long path.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'title-api-')));
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp'), work = path.join(root, 'project');
  const config = path.join(root, 'config'), cache = path.join(root, 'cache'), data = path.join(root, 'data'), notes = path.join(root, 'notes');
  const agent = path.join(home, '.pi/agent');
  for (const p of [home, tmp, work, config, cache, data, notes, path.join(agent, 'sessions/fixture')]) fs.mkdirSync(p, { recursive: true });
  const rel = options.rel || 'fixture/source.jsonl', key = 'pi:' + rel, source = path.join(agent, 'sessions', rel);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    { type: 'session', version: 3, id: 'fixture-session', cwd: work, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: options.content || 'Keep fixture paths exact.' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const settingsFile = path.join(config, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ settingsVersion: 3, welcome: { doneAt: 'fixture' }, backgroundAi: { decidedAt: 'fixture', names: false, memory: false }, ...options.settings }));
  const callsFile = path.join(root, 'cli-calls.jsonl'), answerFile = path.join(root, 'answer'), delayFile = path.join(root, 'delay');
  fs.writeFileSync(answerFile, '<label>Fixture</label><title>Fixture generated title</title>'); fs.writeFileSync(delayFile, '0');
  const cli = path.join(root, 'fake-pi.cjs');
  fs.writeFileSync(cli, `const fs=require('node:fs');const args=process.argv.slice(2);const at=args.indexOf('--system-prompt');const system=at<0?'':fs.readFileSync(args[at+1],'utf8');
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args,system})+'\\n');
if(args.includes('--list-models')) { process.stdout.write('provider        model           context   max-out   thinking   images\\nfake            fixture         128K      8K        no         yes\\n'); }
else if(args.includes('--version')) process.stdout.write('0.87.1\\n');
else if(at>=0) { fs.readFileSync(0,'utf8');setTimeout(()=>process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:fs.readFileSync(${JSON.stringify(answerFile)},'utf8')}],stopReason:'stop',provider:'fake',model:'fixture',timestamp:Date.now(),usage:{input:2,output:2,totalTokens:4}}})+'\\n'),Number(fs.readFileSync(${JSON.stringify(delayFile)},'utf8'))); }
`);
  const p = await port(), previewPort = await port(), token = 'local-integration-synthetic-token';
  const env = {
    ...fixtureChild.systemEnv(), HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, XDG_STATE_HOME: path.join(root, 'state'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, PI_OFFLINE: '1',
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CHATTERING_CONFIG_DIR: config, CHATTERING_CACHE_DIR: cache, CHATTERING_DATA_DIR: data, CHATTERING_NOTES_DIR: notes,
    CHATTERING_DELEGATION_ROOT: path.join(data, 'delegations'), CHATTERING_CHECKPOINT_DIR: path.join(data, 'checkpoints'),
    CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_CHECKPOINT_MAINTENANCE: '0', CHATTERING_NO_SYNC: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1', CHATTERING_DISABLE_DELEGATION_CALLBACKS: '1',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, PORT: String(p), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_PI_CLI: cli, CHATTERING_PI_PACKAGE_DIR: path.resolve(__dirname, '../runtime/node_modules/@earendil-works/pi-coding-agent'),
    FUNCTAI_LOG_CALLS: path.join(data, 'functai/calls'), ...(options.env || {}),
  };
  const progressFile = path.join(root, 'child-progress.json');
  env.CHATTERING_TITLE_FIXTURE_PROGRESS = progressFile;
  env.CHATTERING_TITLE_FIXTURE_PROJECT = work;
  let state;
  const start = () => {
    fs.rmSync(progressFile, { force: true }); // never report the previous boot's progress
    const child = spawn(process.execPath, ['--require', path.resolve(__dirname, 'title-fixture-progress.cjs'), ...(options.instrument ? ['--require', path.resolve(__dirname, 'title-api-instrument.cjs')] : []), 'server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    state = fixtureChild.observeChild(child, [token], { progressFile });
    state.phase('child starting');
  };
  const stop = () => fixtureChild.stop(state);
  t.after(async () => {
    if (t.signal.aborted && state) t.diagnostic(state.failure('test aborted', new Error('Test budget exhausted; no phase inferred')).message);
    await stop(); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + p;
  const request = (route, body, method = body === undefined ? 'GET' : 'POST', credential = token) => fixtureChild.request(state, base + route, {
    method, headers: { Authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  // Rescan includes upstream Git probes. Keep it within the original 30s test
  // budget instead of imposing the newly added 5s fast-request deadline.
  }, route === '/api/rescan' ? 25000 : 5000);
  const wait = async (fn, label = 'fixture condition', timeout) => {
    state.phase('wait ' + label);
    try { return await until(fn, label, timeout); }
    catch (error) { throw state.failure('wait ' + label, error); }
  };
  const ready = async () => {
    let lastError, lastStatus = 'no successful response';
    state.phase('server scan readiness');
    try {
      await until(async () => {
        if (state.closed || state.exit || state.spawnError) throw new Error('Child stopped');
        try {
          const response = await request('/api/sessions');
          lastStatus = `HTTP ${response.status}; sessions=${Array.isArray(response.data) ? response.data.length : 'not an array'}`;
          return Array.isArray(response.data) && response.data.some(e => e.key === key);
        } catch (error) { lastError = error.message.split('\nchild pid=')[0]; return false; }
      }, 'server scan');
      state.phase('server scan ready');
    } catch (error) { throw state.failure('server scan GET ' + base + '/api/sessions', new Error(`${error.message}; last response: ${lastStatus}; last transport error: ${lastError || 'none'}`)); }
  };
  const calls = () => { try { return fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  if (options.setup) await options.setup({ root, home, agent, work, notes, cache, config, env, source });
  start(); await ready();
  return { root, home, tmp, work, notes, config, cache, agent, source, key, settingsFile, answerFile, delayFile, env, base, token, previewPort, request, calls,
    cachePath: path.join(cache, 'sessions', key.replace(/[:/\\]/g, '__') + '.json'), log: () => state.log(), stop, until: wait,
    probe: operation => fixtureChild.probe(state, operation),
    restart: async () => { await stop(); start(); await ready(); } };
}
module.exports = { boot, until, sleep, port };
