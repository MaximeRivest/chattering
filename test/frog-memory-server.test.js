'use strict';
// The frog's memory on a real server (design/102, part 3): its old turns
// are written into the memory by a stand-in model, a compaction entry is
// added to its conversation (the file keeps everything), the print, recall
// and zoom answer, a second pass does nothing, and a new segment is chained
// to the old part with the memory in front. No network, no model.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(r => setTimeout(r, ms));

test('the frog remembers: digest, compaction entry, print, recall, zoom, a new segment', { timeout: 90000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.frog-memory-test-')));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { const gone = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await gone; }
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const agent = path.join(home, '.pi/agent'), cache = path.join(home, 'cache'), folder = path.join(home, 'Projects', 'assistant');
  const notes = path.join(home, 'notes', 'chattering');
  fs.mkdirSync(path.join(folder, 'automations'), { recursive: true }); fs.mkdirSync(cache);
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), '# The assistant\n');
  const mode = JSON.parse(fs.readFileSync(path.join(root, 'extensions/modes/frog.json'), 'utf8'));
  fs.mkdirSync(path.join(agent, 'modes'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'modes', 'frog.json'), JSON.stringify(mode, null, 2));
  const dir = path.join(agent, 'sessions', '--' + folder.replace(/^\//, '').replace(/\//g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '01a149d2-84cd-767d-8f7e-72e3ccc83fcb';
  const file = path.join(dir, '2026-10-17T12-24-55-757Z_' + sid + '.jsonl');
  // Twenty turns: a question, a workspace note, a tool step with a long result, an answer.
  const rows = [{ type: 'session', version: 3, id: sid, cwd: folder, timestamp: '2026-10-17T12:24:55.757Z' }];
  let parent = null, n = 0;
  const add = r => { const id = 'e' + (++n); rows.push({ id, parentId: parent, timestamp: '2026-10-17T12:' + String(25 + n).padStart(2, '0') + ':00.000Z', ...r }); parent = id; return id; };
  add({ type: 'custom', customType: 'mode-switch', data: { version: 1, mode: 'frog', definition: mode } });
  const userIds = [];
  for (let i = 0; i < 20; i++) {
    userIds.push(add({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Question ' + i + ': send the paper one my note about figure ' + i } ] } }));
    add({ type: 'custom_message', customType: 'frog-workspace', content: 'Workspace at 12:' + i + ' (live): three working', display: false });
    add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Sending it.' }, { type: 'toolCall', id: 'c' + i, name: 'send_to_conversation', arguments: { id: 'ab12', text: 'note about figure ' + i } }], provider: 'claude-code', model: 'claude-opus-5-5' } });
    add({ type: 'message', message: { role: 'toolResult', toolCallId: 'c' + i, toolName: 'send_to_conversation', content: [{ type: 'text', text: '{"sent":true,"title":"The paper"}' + ' '.repeat(2000) }], isError: false } });
    add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: it went to the paper one, turn ' + i + '.' }], provider: 'claude-code', model: 'claude-opus-5-5', usage: { input: 10, output: 20, cacheRead: 1000 * (i + 1), cacheWrite: 0, totalTokens: 1000 * (i + 1) + 30 } } });
  }
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const key = 'pi:' + path.relative(path.join(agent, 'sessions'), file);
  fs.mkdirSync(path.join(notes, 'frog'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'frog', 'state.json'), JSON.stringify({ key, folder, createdAt: 1792239896063, model: 'claude-code/claude-opus-5-5' }));
  const programCalls = path.join(home, 'programs.jsonl'), runs = path.join(home, 'runs.jsonl');
  const preload = path.join(home, 'fake-model.cjs');
  fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(path.join(root, 'server.js'))}) {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const ap = require(${JSON.stringify(path.join(root, 'ai-programs.js'))});
  const made = ap.createAiPrograms;
  ap.createAiPrograms = o => {
    const programs = made(o), run = programs.run;
    programs.run = async (name, inputs, opts) => {
      fs.appendFileSync(${JSON.stringify(programCalls)}, JSON.stringify({ name, inputs: { ...inputs, transcript: inputs.transcript ? inputs.transcript.length : undefined }, lm: opts && opts.lm }) + '\\n');
      if (name === 'frog_memory_lines') {
        const turns = [...inputs.transcript.matchAll(/Question (\\d+)/g)].map(m => m[1]);
        return { outputs: { lines: ['- The person sent notes about figures ' + turns[0] + ' to ' + turns[turns.length - 1] + ' to the paper one.', 'Figure ' + turns[0] + ' matters most to the person.'] }, callId: 'fake' };
      }
      if (name === 'frog_memory_merge') return { outputs: { line: 'Summed up ' + inputs.range + ': ' + inputs.lines.length + ' lines.' }, callId: 'fake' };
      return run(name, inputs, opts);
    };
    return programs;
  };
  const sdk = require(${JSON.stringify(path.join(root, 'pisdk.js'))});
  sdk.piHeadlessRun = (target, options) => {
    fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ file: target.sessionPath, message: options.message, custom: options.customMessage || null }) + '\\n');
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    const append = row => {
      const entries = fs.readFileSync(target.sessionPath, 'utf8').trim().split('\\n').map(JSON.parse);
      const last = entries.at(-1);
      fs.appendFileSync(target.sessionPath, JSON.stringify({ id: crypto.randomUUID().slice(0, 8), parentId: last.type === 'session' ? null : last.id, timestamp: new Date().toISOString(), ...row }) + '\\n');
      if (row.message) { options.onEvent({ type: 'message_start', message: row.message }); options.onEvent({ type: 'message_end', message: row.message }); }
    };
    if (options.customMessage) append({ type: 'custom_message', customType: options.customMessage.customType, content: options.customMessage.content, display: true });
    else append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: options.message }] } });
    const timer = setTimeout(() => { append({ type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'fixture', content: [{ type: 'text', text: 'Here I am, fresh.' }], stopReason: 'stop' } }); doneResolve(); }, 60);
    return { done, abort: async () => { clearTimeout(timer); doneResolve(); } };
  };
}
`);
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  const machineEnv = { ...process.env }; delete machineEnv.TYPESAFE_API_KEY;
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...machineEnv,
    ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1',
    CHATTERING_CACHE_DIR: cache, CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, NODE_OPTIONS: '--require=' + preload,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  const call = async (route, body) => {
    const r = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) } : { signal: AbortSignal.timeout(10000) });
    return { status: r.status, ...(await r.json()) };
  };
  for (let i = 0; i < 400; i++) { try { if ((await (await fetch(base + '/api/sessions')).json()).some(s => s.key === key)) break; } catch {} await pause(50); }
  const homeNow = await call('/api/frog/home', {});
  assert.equal(homeNow.key, key, JSON.stringify(homeNow) + log.slice(-2000));

  // Empty at first; on by default, with a switch of its own (the machine's
  // background AI is undecided in this home, and that is no concern of the frog's).
  const empty = await call('/api/frog/memory');
  assert.equal(empty.memories, 0); assert.match(empty.text, /empty so far/); assert.equal(empty.on, true);
  assert.equal((await call('/api/settings')).frog.memory, true);
  assert.equal((await call('/api/frog/memory/switch', { on: false })).on, false);
  assert.equal((await call('/api/frog/memory/compact', {})).skipped, 'the frog\u2019s memory is off');
  assert.equal((await call('/api/settings')).frog.memory, false);
  assert.equal((await call('/api/frog/memory/switch', { on: true })).on, true);
  // Turned on, a pass runs by itself: 20 turns, in steps of 8, so 8 digested and 12 kept.
  let pass = null;
  for (let i = 0; i < 200 && !(pass && pass.compacted); i++) { await pause(100); pass = (await call('/api/frog/memory')).last; }
  assert.ok(pass && pass.compacted, JSON.stringify(pass) + log.slice(-3000));
  assert.equal(pass.compacted, true, JSON.stringify(pass));
  assert.equal(pass.dropped, 8); assert.equal(pass.kept, 12);
  assert.equal(pass.digested, 2); assert.equal(pass.memories, 2);
  assert.equal(pass.tokensBefore, 20030);
  const calls = fs.readFileSync(programCalls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c => c.name === 'frog_memory_lines').length, 1, 'eight small turns: one digest call');
  assert.equal(calls[0].lm, 'claude-code/claude-opus-5-5', 'on the frog\u2019s own model');
  assert.deepEqual(calls[0].inputs.known, []);
  // The file: everything still there, a compaction entry last, pointing at turn 9's message.
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.length, rows.length + 1, 'one entry added, nothing removed');
  const comp = after.at(-1);
  assert.equal(comp.type, 'compaction'); assert.equal(comp.firstKeptEntryId, userIds[8]); assert.equal(comp.parentId, 'e' + n); assert.equal(comp.fromHook, true);
  assert.match(comp.summary, /Your memory of this conversation/); assert.match(comp.summary, /#0 2026-\d\d-\d\d The person sent notes about figures 0 to 7/); assert.match(comp.summary, /#1 .*Figure 0 matters/);
  assert.ok(!/^- /m.test(comp.summary), 'no bullets in the lines');
  // The log on disk: append-only lines with where each came from.
  const logLines = fs.readFileSync(path.join(notes, 'frog', 'memory', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logLines.length, 2); assert.equal(logLines[0].src.from, 'e1'); assert.equal(logLines[0].src.to, after[rows.length - 1 - 12 * 5 + 0].id || logLines[0].src.to);
  assert.equal(logLines[0].src.conv, '01a149d2');
  // The reader shows the compaction as an event, the messages above it kept.
  const session = await call('/api/session?id=' + encodeURIComponent(key));
  assert.ok(session.messages.some(m => m.role === 'event' && m.customType === 'compaction'), 'the reader shows where the model continues from');
  assert.ok(session.messages.filter(m => m.role === 'user').length >= 20, 'the person\u2019s messages all stay');

  // Again: nothing due, nothing written twice.
  const again = await call('/api/frog/memory/compact', {});
  assert.equal(again.compacted, false); assert.equal(again.digested, 0); assert.equal(again.why, 'nothing due');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, rows.length + 1);

  // The memory answers: print, recall, zoom, a note of the frog's own.
  const printed = await call('/api/frog/memory');
  assert.equal(printed.memories, 2); assert.match(printed.text, /#0 /); assert.equal(printed.digested.entryId, logLines[0].src.to);
  const recalled = await call('/api/frog/memory/recall?q=figure%200');
  assert.equal(recalled.total, 2);
  const noted = await call('/api/frog/memory/note', { text: '  Lilly\u2019s recital is Friday at seven.  ' });
  assert.equal(noted.saved, '#2'); assert.equal(noted.memories, 3);
  assert.equal((await call('/api/frog/memory/recall?q=recital')).matches[0].src.from, comp.id, 'a note names the entry the conversation was at');
  const zoomed = await call('/api/frog/memory/zoom?id=%230-1');
  assert.equal(zoomed.status, 200, JSON.stringify(zoomed));
  assert.equal(zoomed.halves[0].id, '#0'); assert.match(zoomed.halves[0].lines[0].text, /figures 0 to 7/);
  assert.equal((await call('/api/frog/memory/zoom?id=%234-6')).status, 400, 'not a range: refused');
  // read_conversation around an entry a memory names.
  const around = await call('/api/frog/read?id=01a149d2&at=' + userIds[3] + '&last=4');
  assert.equal(around.around, userIds[3]); assert.ok(around.messages.some(m => m.entryId === userIds[3] && /Question 3/.test(m.text)));

  // A new segment: the old part digested down to the last 8 turns (12 - 8 = 4 more digested, in 1 call), a new file with the memory in front.
  const seg = await call('/api/frog/memory/segment', { message: 'Greet the person and say the memory came along.' });
  assert.equal(seg.status, 200, JSON.stringify(seg) + log.slice(-3000));
  assert.equal(seg.started, true);
  await pause(300);
  const home2 = await call('/api/frog/home');
  assert.notEqual(home2.key, key, 'the frog\u2019s conversation moved: ' + JSON.stringify(home2));
  const newKey = home2.key;
  const newFile = path.join(agent, 'sessions', newKey.slice('pi:'.length));
  const fresh = fs.readFileSync(newFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(fresh[0].type, 'session'); assert.equal(fresh[0].cwd, folder);
  assert.deepEqual([fresh[1].customType, fresh[1].data.mode], ['mode-switch', 'frog']);
  assert.equal(fresh[2].type, 'compaction'); assert.equal(fresh[2].firstKeptEntryId, fresh[2].id); assert.equal(fresh[2].parentId, fresh[1].id);
  assert.match(fresh[2].summary, /figures 8 to 11/, 'the turns between were digested first');
  assert.match(fresh[2].summary, /recital/);
  const carriedUsers = fresh.filter(e => e.type === 'message' && e.message.role === 'user' && e.chatteringCarried === key);
  assert.equal(carriedUsers.length, 8, 'the last eight turns came along as they were');
  assert.match(carriedUsers[0].message.content[0].text, /Question 12/);
  assert.ok(fresh.filter(e => e.type === 'message' && e.message.role === 'toolResult').length === 8, 'tool results too (the provider pairs them with their calls)');
  assert.equal(fresh[1].parentId, null);
  for (let i = 2; i < fresh.length; i++) assert.equal(fresh[i].parentId, fresh[i - 1].id, 'one line of entries');
  // Chained: the old part says where it went on; the list shows one row.
  const oldView = await call('/api/session?id=' + encodeURIComponent(key));
  assert.equal(oldView.continuedIn && oldView.continuedIn.key, newKey);
  const sessions = await (await fetch(base + '/api/sessions')).json();
  assert.ok(sessions.some(s => s.key === newKey) && !sessions.some(s => s.key === key && !s.hidden), 'the newest part stands for the conversation');
  assert.equal(JSON.parse(fs.readFileSync(path.join(notes, 'frog', 'state.json'), 'utf8')).key, newKey);
  // Its first turn there: the message, as a note of the frog's own (not the person's words).
  for (let i = 0; i < 100 && !fs.existsSync(runs); i++) await pause(50);
  const run = fs.readFileSync(runs, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.file === newFile);
  assert.ok(run && run.custom && run.custom.customType === 'frog-fresh' && /Greet the person/.test(run.custom.content), JSON.stringify(run));
  // The old file: still whole, nothing removed.
  assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').length >= rows.length + 1);
});
