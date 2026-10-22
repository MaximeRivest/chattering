'use strict';
// Antigravity CLI and Muse Code conversations read into Chattering's
// transcript shape (harness/agy-transcript.js, harness/muse-transcript.js).
// The Antigravity fixture is a real conversation written by `agy` 1.3.4
// (2026-10-14: read a file, ran two commands, wrote a file, answered),
// repacked smaller and with its generator records removed. The Muse Code
// file is built here from the record shapes Muse Code 1.4.6 writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agy = require('../harness/agy-transcript.js');
const muse = require('../harness/muse-transcript.js');

const AGY_FIXTURE = path.join(__dirname, 'fixtures', 'agy', 'a2e5ac21-7dd0-45aa-af46-3efea29c3b28.db');

test('Antigravity: which files are conversations', () => {
  assert.equal(agy.isAgyConversation('a2e5ac21-7dd0-45aa-af46-3efea29c3b28.db'), true);
  assert.equal(agy.isAgyConversation('a2e5ac21-7dd0-45aa-af46-3efea29c3b28.db-wal'), false);
  assert.equal(agy.isAgyConversation('a2e5ac21-7dd0-45aa-af46-3efea29c3b28.db-shm'), false);
  assert.equal(agy.isAgyConversation('notes.db'), false);
});

test('Antigravity: a real conversation, step by step', () => {
  const { meta, messages, entryParents } = agy.parseAgyConversation(AGY_FIXTURE);
  assert.equal(meta.sessionId, 'a2e5ac21-7dd0-45aa-af46-3efea29c3b28');
  assert.equal(meta.cwd, '/tmp/agy-probe');
  assert.equal(meta.rootId, 'agy:a2e5ac21-7dd0-45aa-af46-3efea29c3b28');
  assert.equal(meta.firstTs, '2026-10-14T11:51:15.445Z');
  assert.ok(meta.lastTs > meta.firstTs);
  assert.ok(meta.ctx.used > 10000, 'the tokens of its last answer');
  assert.equal(meta.agy.helper, false);
  const shape = messages.map(m => m.role + (m.name ? ':' + m.name : ''));
  assert.deepEqual(shape, ['user', 'tool:read', 'toolresult', 'thinking', 'tool:bash', 'toolresult', 'tool:write', 'toolresult', 'tool:bash', 'toolresult', 'thinking', 'assistant']);
  assert.match(messages[0].text, /^Read notes\.txt, then create a file reply\.txt/);
  assert.equal(messages[1].path, '/tmp/agy-probe/notes.txt');
  assert.equal(messages[4].text, 'ls -la /tmp/agy-probe');
  assert.deepEqual(messages[6].writes, ['/tmp/agy-probe/reply.txt']);
  assert.equal(messages[6].id, messages[7].tid, 'a result names its call');
  assert.equal(messages[5].err, false);
  assert.match(messages[11].text, /created \[reply\.txt\]/);
  assert.equal(messages[11].provider, 'agy');
  // The tool calls the answers asked for are shown once, from their own steps.
  assert.equal(messages.filter(m => m.role === 'tool').length, 4);
  // One line: every entry's parent is the one before.
  assert.deepEqual(entryParents[0], ['s0', null]);
  for (let i = 1; i < entryParents.length; i++) assert.equal(entryParents[i][1], entryParents[i - 1][0]);
  assert.ok(messages.every(m => entryParents.some(([id]) => id === m.eid)));
});

test('Antigravity: the reader never writes the database it reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-read-'));
  try {
    const f = path.join(dir, path.basename(AGY_FIXTURE));
    fs.copyFileSync(AGY_FIXTURE, f);
    const before = fs.readFileSync(f);
    agy.parseAgyConversation(f);
    assert.deepEqual(fs.readFileSync(f), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Antigravity: the wire reader skips what it does not know and survives a cut message', () => {
  // field 1 = 14 (varint), field 2 = "hi" (length-delimited), field 3 = a
  // fixed 32-bit value, then a length that runs past the end.
  const buf = Buffer.from([0x08, 0x0e, 0x12, 0x02, 0x68, 0x69, 0x1d, 1, 2, 3, 4, 0x22, 0x40, 0x61]);
  const f = agy.fields(buf);
  assert.equal(f.get(1)[0], 14);
  assert.equal(f.get(2)[0].toString(), 'hi');
  assert.equal(f.get(3).length, 1);
  assert.equal(f.has(4), false);
  assert.equal(agy.fields(null).size, 0);
});

// ---- Muse Code ----
let seq = 0;
const SID = '01a13a47-1b01-7db3-a22c-6ad7395ad976';
const T0 = Date.parse('2026-10-14T11:58:00Z') * 1000;
function rec(payloadType, payload, at = seq) {
  seq++;
  return { schema_version: 1, id: 'r' + seq, stream: { kind: 'session', id: SID }, sequence: seq, recorded_at: T0 + at * 1000000, record_type: 'event', durability: 'durable', causation_id: null, payload_type: payloadType, payload_schema_version: 1, payload };
}
const run = (event, at) => rec('runtime.session', { kind: 'run', run_id: 'run1', event }, at);
function museFile(dir) {
  seq = 0;
  const lines = [
    // Several records in one line, as Muse Code writes its first transaction.
    { retained_frame: 'session_permission_transaction', frame_schema_version: 1, outer_log_ordinal: 1, children: [
      { child_index: 0, record_json: JSON.stringify(rec('runtime.session.permission_format_declared', { format: 'profile_v1' })) },
      { child_index: 1, record_json: JSON.stringify(rec('runtime.session.metadata', { kind: 'metadata', record: { build: { semver: '1.4.6' }, model_id: 'muse-wonder-1.0', workspace_root: '/work/app' } })) },
    ] },
    rec('runtime.session.route_facts', { kind: 'route_facts', record: { cwd: '/work/app', pid: 4242 } }),
    rec('session.workspace_branch.observed', { kind: 'workspace_branch', record: { reference: { kind: 'branch', name: 'main' }, vcs: 'git' } }),
    rec('runtime.user_intent.accepted', { surface: 'main', semantic_kind: { kind: 'chat' }, refill_blocks: [{ kind: 'text', text: 'Make hello.txt and run the tests' }] }, 1),
    run({ kind: 'reasoning_committed', text: '', encrypted_content: 'xxx' }, 2),
    run({ kind: 'assistant_tool_calls_committed', tool_calls: [
      { call_id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'hello.txt', content: 'hi' }) },
      { call_id: 'c2', name: 'bash', args: JSON.stringify({ command: 'npm test' }) },
    ] }, 3),
    { retained_marker: 'omitted_live_only', schema_version: 1, stream: { kind: 'session', id: SID } },
    run({ kind: 'tool_result_batch_committed', results: [
      { tool_call_id: 'c1', text: 'wrote 2 bytes to /work/app/hello.txt' },
      { tool_call_id: 'c2', text: JSON.stringify({ command: 'npm test', exit_code: 1, terminal_status: 'completed', output: '1 failing' }) },
    ] }, 4),
    run({ kind: 'model_completed', model: 'muse-wonder-1.0', usage: { input_tokens: 24000, output_tokens: 500 } }, 5),
    run({ kind: 'assistant_message_committed', text: 'Wrote hello.txt; one test fails.' }, 6),
    run({ kind: 'terminal', terminal: 'completed' }, 7),
    rec('runtime.user_intent.accepted', { surface: 'main', semantic_kind: { kind: 'chat' }, refill_blocks: [{ kind: 'text', text: 'fix it' }] }, 8),
    run({ kind: 'terminal', terminal: 'failed', reason: 'API error 429: usage limit reached' }, 9),
    // A helper's intent is not what the person typed.
    rec('runtime.user_intent.accepted', { surface: 'reminder', semantic_kind: { kind: 'chat' }, refill_blocks: [{ kind: 'text', text: 'internal' }] }, 10),
    'not json',
  ];
  const f = path.join(dir, '2026', '10', '14', SID, 'session.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
  fs.mkdirSync(path.join(path.dirname(f), 'subagent', 'h1'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(f), 'subagent', 'h1', 'session.jsonl'), '');
  return f;
}

test('Muse Code: which files are conversations (not its helpers\')', () => {
  assert.equal(muse.isMuseSession(`2026/10/14/${SID}/session.jsonl`), true);
  assert.equal(muse.isMuseSession(`2026/10/14/${SID}/subagent/h1/session.jsonl`), false);
  assert.equal(muse.isMuseSession(`.msp-view-v1/${SID}/HEAD.json`), false);
  assert.equal(muse.museSessionsDir({ XDG_DATA_HOME: '/data' }, '/home/me'), '/data/muse/sessions');
  assert.equal(muse.museSessionsDir({}, '/home/me'), '/home/me/.local/share/muse/sessions');
});

test('Muse Code: a conversation with tool calls, a failing test, and a turn stopped by the usage limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-read-'));
  try {
    const { meta, messages, entryParents } = await muse.parseMuseSession(museFile(dir));
    assert.equal(meta.sessionId, SID);
    assert.equal(meta.cwd, '/work/app');
    assert.equal(meta.gitBranch, 'main');
    assert.equal(meta.rootId, 'muse:' + SID);
    assert.equal(meta.muse.model, 'muse-wonder-1.0');
    assert.deepEqual(meta.ctx, { used: 24500, provider: 'muse', model: 'muse-wonder-1.0', window: null });
    assert.equal(meta.firstTs, '2026-10-14T11:58:00.000Z');
    assert.deepEqual(messages.map(m => m.role + (m.name ? ':' + m.name : '')), ['user', 'tool:write', 'tool:bash', 'toolresult', 'toolresult', 'assistant', 'user', 'abort']);
    assert.equal(messages[0].text, 'Make hello.txt and run the tests');
    assert.deepEqual(messages[1].writes, ['/work/app/hello.txt']);
    assert.equal(messages[2].text, 'npm test');
    assert.equal(messages[3].err, false);
    assert.equal(messages[4].err, true, 'a non-zero exit is a failure');
    assert.equal(messages[4].text, '1 failing');
    assert.equal(messages[4].tid, 'c2');
    assert.equal(messages[5].model, 'muse-wonder-1.0');
    assert.match(messages[7].text, /^stopped: API error 429/);
    assert.equal(new Set(messages.map(m => m.eid)).size, messages.length);
    for (let i = 1; i < entryParents.length; i++) assert.equal(entryParents[i][1], entryParents[i - 1][0]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
