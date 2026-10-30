'use strict';
// Plug-ins (MCP servers) in Chattering's own box, as in Pi's own program
// (design/108): a server in the person's mcp.json is connected when the
// conversation's Pi starts, and its tools answer the model. A folder's own
// servers (.pi/mcp.json) load once the folder is trusted: /trust here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');

const root = path.join(__dirname, '..');
const FAKE_MCP = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const until = async (fn, ms, what) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await new Promise(r => setTimeout(r, 150)); } };
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

test('an MCP server of the person answers in Chattering\u2019s box; a folder\u2019s own once trusted', { timeout: 180000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-box-')));
  const agent = path.join(home, '.pi', 'agent'), work = path.join(home, 'Projects', 'plugins');
  fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  const callLog = path.join(home, 'mcp-calls.jsonl');
  const server = name => ({ command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_LOG: callLog }, exposure: 'direct', description: 'A test server called ' + name });
  // One of the person's own (user level), one the folder brings (project level).
  fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { mine: server('mine') } }));
  fs.mkdirSync(path.join(work, '.pi'));
  fs.writeFileSync(path.join(work, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { folder: server('folder') } }));
  require('./helpers/first-run.js').answerFirstRun(home);

  // The model calls the tool it is told to, then answers with what it said.
  // Only this turn counts: the latest question and what came after it.
  const model = await fakeOpenAI({ reply: p => {
    // (Pi may append a note about its plug-ins after the question.)
    const last = p.messages.map(m => m.role === 'user' && /please use/i.test(JSON.stringify(m.content))).lastIndexOf(true);
    const turn = p.messages.slice(last);
    const tool = /use (mcp__\w+__echo)/.exec(JSON.stringify(turn[0]));
    const tools = (p.tools || []).map(x => (x.function || x).name);
    const result = turn.find(m => m.role === 'tool');
    if (tool && !result) return tools.includes(tool[1]) ? { tool: { name: tool[1], arguments: { text: 'hello plug-in' } } } : 'NO SUCH TOOL ' + tool[1] + ' among ' + tools.join(',');
    return result ? 'The tool said: ' + JSON.stringify(result.content) : 'Hello.';
  } });
  t.after(() => model.close());
  const port = await freePort();
  registerConsole(port, 'tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'tok', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_PREVIEW_PORT: '0', CHATTERING_PREVIEW_TLS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  await until(async () => { try { return (await fetch(base + '/api/sessions')).ok; } catch { return false; } }, 30000, 'the server');
  const fail = what => what + '\n--- server log ---\n' + log.slice(-3000);
  const ai = (await post('/api/ai/server', { baseUrl: model.baseUrl })).body;
  const models = [{ provider: ai.name, modelId: 'fixture-chat' }];
  const finished = async id => until(async () => { const jobs = await (await fetch(base + '/api/jobs')).json(); const j = jobs.find(x => x.id === id); return j && j.status !== 'running' && j; }, 90000, 'the reply');
  const lastReply = async key => { const s = await (await fetch(base + '/api/session?id=' + encodeURIComponent(key))).json(); return [...s.messages].reverse().find(m => m.role === 'assistant').text; };

  // The person's own server: its tool runs, and its answer reaches the model.
  const started = await post('/api/conversation/start-loose', { folder: work, prompt: 'Please use mcp__mine__echo', models });
  assert.equal(started.status, 200, fail(JSON.stringify(started.body)));
  const key = started.body.key;
  await finished(started.body.job.id);
  assert.match(await lastReply(key), /echo: hello plug-in/, fail('the reply'));
  assert.equal(fs.readFileSync(callLog, 'utf8').trim().split('\n').length, 1, 'the tool ran once');

  // Pi's /mcp answers here too (its status as a notice on the reply): the
  // same command signs in to a server (/mcp login <server>), its link shown
  // here and the address it leads to pasted into the question it asks.
  const status = await post('/api/node/send', { id: key, prompt: '/mcp', models });
  assert.equal(status.status, 202, JSON.stringify(status.body));
  const statusJob = await finished(status.body.job.id);
  assert.match(JSON.stringify(statusJob.notices || []), /mine/, fail('the /mcp notice: ' + JSON.stringify(statusJob)));

  // The folder's own server is not loaded until the folder is trusted.
  const before = await post('/api/node/send', { id: key, prompt: 'Please use mcp__folder__echo', models });
  assert.equal(before.status, 202);
  await finished(before.body.job.id);
  assert.match(await lastReply(key), /NO SUCH TOOL mcp__folder__echo/, 'not loaded before /trust');
  const trusted = await post('/api/project/trust', { id: key, trust: true });
  assert.deepEqual([trusted.status, trusted.body.needed, trusted.body.trusted], [200, true, true], JSON.stringify(trusted.body));
  assert.ok(JSON.parse(fs.readFileSync(path.join(agent, 'trust.json'), 'utf8'))[work] === true || fs.readFileSync(path.join(agent, 'trust.json'), 'utf8').includes(work), 'saved in Pi\u2019s own trust file');
  const after = await post('/api/node/send', { id: key, prompt: 'Now please use mcp__folder__echo', models });
  assert.equal(after.status, 202);
  await finished(after.body.job.id);
  assert.match(await lastReply(key), /echo: hello plug-in/, fail('after /trust'));
  assert.equal(fs.readFileSync(callLog, 'utf8').trim().split('\n').length, 2);
});
