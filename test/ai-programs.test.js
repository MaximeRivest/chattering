'use strict';
// Chattering's own AI programs (ai-programs.js) and their routers
// (pirouter.js), offline: a fake `pi` answers (design/74).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiPrograms, functai } = require('../ai-programs.js');
const router = require('../pirouter.js');
const aiCommands = require('../ai-commands.js');

const piReply = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', provider: 'openai-codex', model: 'gpt-x',
  usage: { input: 120, output: 9, cacheRead: 3, cacheWrite: 0, totalTokens: 132 }, ...extra });

function setup(t, reply, { contentLimit, live } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-programs-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const sent = [];
  const programs = createAiPrograms({
    piExec: async m => {
      sent.push(m);
      const answer = typeof reply === 'function' ? reply(m, sent.length) : piReply(reply);
      if (m.onThinking) for (const piece of (m.thinkingStream || [])) m.onThinking(piece);
      if (m.onDelta) for (const piece of (m.stream || [])) m.onDelta(piece);
      return answer;
    },
    chatPost: async (url, body) => { sent.push({ url, body }); return { status: 200, json: { model: 'qwen', choices: [{ message: { content: typeof reply === 'function' ? reply(body) : reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } } }; },
    voiceEndpoint: () => ({ url: 'http://voice/v1/chat/completions', model: 'qwen', timeoutMs: 1000 }),
    lm: () => 'openai-codex/gpt-x', logFolder: () => folder, ...(contentLimit ? { contentLimit } : {}), ...(live ? { live } : {}),
  });
  const records = () => fs.readdirSync(folder).flatMap(d => fs.readdirSync(path.join(folder, d)).flatMap(f => fs.readFileSync(path.join(folder, d, f), 'utf8').trim().split('\n').map(JSON.parse)));
  return { programs, sent, records, folder };
}

test('every program lays itself out with its inputs', async t => {
  const { programs } = setup(t, 'x');
  const { lib, defs, fns } = await programs.load();
  assert.ok(Object.keys(defs).length >= 37);
  const sample = shape => shape.type === 'array' ? [sample(shape.items || { type: 'string' })] : shape.type === 'integer' ? 1 : shape.type === 'object' ? { id: 1, request: 'r' } : 'v';
  for (const [name, fn] of Object.entries(fns)) {
    const inputs = Object.fromEntries(Object.entries(defs[name].inputs).map(([k, shape]) => [k, k === 'nonce' ? 'abcdef12' : sample(shape)]));
    const r = lib.withSettings({ lm: 'openai-codex/gpt-x' }, () => fn.render(inputs));
    assert.ok(r.messages.length === 1, name);
    assert.match(fn.version, /^sha256:[0-9a-f]{64}$/, name);
  }
});

test('the Pi router: system and user message, folded turns, usage and failures in lm15 terms', async () => {
  const lib = await functai();
  const single = router.piMessage({ system: 'S', messages: [lib.Message.user('hello')] });
  assert.deepEqual(single, { system: 'S', input: 'hello', folded: false });
  const folded = router.piMessage({ system: 'S', messages: [lib.Message.user('Q'), lib.Message.assistant([{ type: 'text', text: 'bad' }]), lib.Message.user('Your reply could not be read')] });
  assert.equal(folded.folded, true);
  assert.equal(folded.input, 'The message was:\nQ\n\n---\n\nYou replied:\nbad\n\n---\n\nYour reply could not be read');
  const r = router.toResponse(lib, { model: 'm' }, piReply('<t>\nx\n</t>', { stopReason: 'length' }));
  assert.equal(r.finishReason, 'length');
  assert.deepEqual({ ...r.usage }, { inputTokens: 120, outputTokens: 9, totalTokens: 132, cacheReadTokens: 3, cacheWriteTokens: 0 });
  assert.equal(r.model, 'openai-codex/gpt-x');
  assert.throws(() => router.toResponse(lib, { model: 'm' }, { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'rate limited' }), /rate limited/);
  const pi = router.createPiRouter({ lib, exec: async () => piReply('x') });
  assert.deepEqual(pi.resolve('openai-codex/gpt-x'), { provider: 'openai-codex', model: 'gpt-x' });
  assert.deepEqual(pi.resolve('pi-default'), { provider: 'pi', model: 'pi-default' });
});

test('a program runs through Pi, answers typed, and is logged with who called', async t => {
  const { programs, sent, records } = setup(t, '<label>\nAuth loop\n</label>\n<title>\nFix login callback loop\n</title>');
  const out = await programs.run('conversation_title', { opening_user_messages: ['The login redirects forever.'] }, { caller: { conversation: 'pi:x.jsonl', purpose: 'conversation_title' } });
  assert.deepEqual(out.outputs, { label: 'Auth loop', title: 'Fix login callback loop' });
  assert.match(sent[0].system, /^Function: conversation_title\n\nName the actual work/);
  assert.match(sent[0].system, /Reply in exactly this form:\n<label>/);
  assert.equal(sent[0].input, '<opening_user_messages>\n[\n  "The login redirects forever."\n]\n</opening_user_messages>\n');
  const [rec] = records();
  assert.equal(rec.id, out.callId);
  assert.deepEqual(rec.caller, { kind: 'chattering', conversation: 'pi:x.jsonl', purpose: 'conversation_title' });
  assert.equal(rec.model, 'openai-codex/gpt-x');
  assert.equal(rec.content, true);
  assert.deepEqual(rec.outputs, { label: 'Auth loop', title: 'Fix login callback loop' });
  assert.equal(rec.usage.input_tokens, 120);
});

test('an unreadable reply is asked again once, the earlier turns folded into the message', async t => {
  const { programs, sent } = setup(t, (m, n) => piReply(n === 1 ? 'Sure! The title is Fix login.' : '<label>\nLogin\n</label>\n<title>\nFix login\n</title>'));
  const out = await programs.run('conversation_title', { opening_user_messages: ['x'] });
  assert.equal(out.outputs.title, 'Fix login');
  assert.equal(sent.length, 2);
  assert.match(sent[1].input, /^The message was:\n<opening_user_messages>[\s\S]*You replied:\nSure! The title is Fix login\.[\s\S]*Your reply could not be read/);
});

test('a transcript-sized input is logged as its size only', async t => {
  const { programs, records } = setup(t, '<evidence>\nIt worked.\n</evidence>', { contentLimit: 100 });
  await programs.run('conversation_evidence', { conversation: 'x'.repeat(500) });
  const [rec] = records();
  assert.equal(rec.content, false);
  assert.equal(rec.inputs, undefined);
  assert.equal(rec.sizes.inputs.conversation, 502);
});

test('a document command: the fenced material, the reply as written, streamed as it comes', async t => {
  const reply = ' and then it rained.';
  const { programs, sent } = setup(t, (m) => { m.stream = [' and then', ' it rained.']; return piReply(reply); });
  const command = aiCommands.commandById('sentence');
  const checked = aiCommands.validateRequest({ command: 'sentence', request: { scope: 'prose', target: { from: 11, to: 11, text: '' }, block: { type: 'prose', text: 'It was late' }, document: 'It was late' } }, 'document');
  const all = aiCommands.programInputs(command, checked.request, { path: 'notes.md', nonce: 'abcdef123456' });
  const inputs = Object.fromEntries((await programs.inputNames('doc_sentence')).map(k => [k, all[k]]));
  const pieces = [];
  const out = await programs.run('doc_sentence', inputs, { onText: p => pieces.push(p) });
  assert.equal(programs.replyText(out.response), reply, 'the leading space kept');
  assert.deepEqual(pieces, [' and then', ' it rained.'], 'the text as Pi streamed it, leading space and all');
  assert.match(sent[0].system, /^You are editing part of a Markdown document for the person who wrote it\./);
  assert.match(sent[0].system, /The cursor is between before-cursor-abcdef123456 and after-cursor-abcdef123456/);
  assert.match(sent[0].input, /^<document-abcdef123456 path="notes\.md">\nIt was late\n<\/document-abcdef123456>/);
  assert.match(sent[0].input, /<before-cursor-abcdef123456>\nIt was late\n<\/before-cursor-abcdef123456>/);
});

test('the spoken-word programs go to the voice model as chat completions', async t => {
  const { programs, sent } = setup(t, '<command>\nnone\n</command>\n<target>\n\n</target>\n<text>\ncan you tell me a joke?\n</text>\n<action>\nsend\n</action>');
  const out = await programs.run('voice_gate', { transcript: 'can you tell me a joke? send' });
  assert.deepEqual(out.outputs, { command: 'none', target: '', text: 'can you tell me a joke?', action: 'send' });
  assert.equal(sent[0].url, 'http://voice/v1/chat/completions');
  assert.equal(sent[0].body.model, 'qwen');
  assert.equal(sent[0].body.max_tokens, 300);
  assert.deepEqual(sent[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(sent[0].body.messages[0].role, 'system');
  assert.equal(sent[0].body.messages[1].content, '<transcript>\ncan you tell me a joke? send\n</transcript>\n');
});

test('memory lanes keep the keys the server reads', async t => {
  const reply = '<recentFocus>\n["the pyramid"]\n</recentFocus>\n<unfinished>\n[]\n</unfinished>\n<todos>\n["tests"]\n</todos>\n<openQuestions>\n[]\n</openQuestions>';
  const { programs } = setup(t, reply);
  const out = await programs.run('project_status', { part: 'the whole project', evidence: 'PROJECT: x\n\nproblems…' });
  assert.deepEqual(out.outputs, { recentFocus: ['the pyramid'], unfinished: [], todos: ['tests'], openQuestions: [] });
});

// ---- watched while they run (design/74, "Live") ----
const { createLiveCalls } = require('../programs-live.js');
function watcher() {
  const ops = [];
  const live = createLiveCalls({ publish: batch => ops.push(...batch), flushMs: 1 });
  const settle = async () => { await new Promise(r => setTimeout(r, 5)); live.flush(); };
  return { live, ops, settle };
}

test('every call is watched: its outputs as the model writes them, then done, under its log id', async t => {
  const w = watcher();
  const reply = '<label>\nAuth loop\n</label>\n<title>\nFix login callback loop\n</title>';
  const { programs, records } = setup(t, m => { m.stream = reply.match(/[\s\S]{1,6}/g); return piReply(reply); }, { live: w.live });
  const out = await programs.run('conversation_title', { opening_user_messages: ['The login redirects forever.'] }, { caller: { conversation: 'pi:x.jsonl', user: 'maxime' } });
  await w.settle();
  const start = w.ops.find(o => o.op === 'start');
  assert.equal(start.id, out.callId, 'the live id is the call log\u2019s id');
  assert.deepEqual([start.call.name, start.call.module, start.call.answer, start.call.outputs], ['conversation_title', 'chattering', 'title', ['label', 'title']]);
  assert.deepEqual(start.call.caller, { kind: 'chattering', conversation: 'pi:x.jsonl', user: 'maxime' });
  const texts = w.ops.filter(o => o.op === 'text');
  assert.ok(texts.length >= 2, 'text arrives as it is written');
  const byField = f => texts.filter(o => o.field === f).map(o => o.text).join('');
  assert.deepEqual([byField('label'), byField('title')], ['Auth loop', 'Fix login callback loop']);
  assert.equal(w.ops.at(-1).op, 'end');
  assert.equal(w.ops.at(-1).state, 'done');
  // Watching changes nothing in the record, except that it says it was streamed.
  const [rec] = records();
  assert.deepEqual(rec.outputs, { label: 'Auth loop', title: 'Fix login callback loop' });
  assert.equal(rec.exchanges[0].streamed, true);
});

test('the model\u2019s thinking is watched, and recorded as a plain call records it', async t => {
  const w = watcher();
  const reply = '<label>\nx\n</label>\n<title>\nFix it\n</title>';
  const { programs, records } = setup(t, m => { m.thinkingStream = ['The user ', 'wants a title.']; m.stream = [reply]; return piReply(reply, { content: [{ type: 'thinking', thinking: 'The user wants a title.' }, { type: 'text', text: reply }] }); }, { live: w.live });
  await programs.run('conversation_title', { opening_user_messages: ['x'] });
  await w.settle();
  assert.equal(w.ops.filter(o => o.op === 'thinking').map(o => o.text).join(''), 'The user wants a title.');
  const parts = records()[0].exchanges[0].response.message.parts;
  assert.deepEqual(parts.map(p => p.type), ['thinking', 'text']);
  assert.equal(parts[0].text, 'The user wants a title.');
});

test('a thinking reply Pi never streamed is still recorded whole', async t => {
  const reply = '<label>\nx\n</label>\n<title>\nFix it\n</title>';
  const { programs, records } = setup(t, () => piReply(reply, { content: [{ type: 'thinking', thinking: 'Hmm.' }, { type: 'text', text: reply }] }));
  await programs.run('conversation_title', { opening_user_messages: ['x'] });
  const parts = records()[0].exchanges[0].response.message.parts;
  assert.deepEqual(parts.map(p => [p.type, p.text]), [['thinking', 'Hmm.'], ['text', reply]]);
});

test('a stop signal stops the call: ABORTED to the caller, cancelled when watched, Cancelled in the log', async t => {
  const w = watcher();
  const stop = new AbortController();
  const { records, folder } = setup(t, null);
  // A Pi call that runs until it is stopped.
  const piExec = m => new Promise((_, reject) => {
    if (m.onDelta) m.onDelta('<label>\nhalf');
    m.signal.addEventListener('abort', () => reject(Object.assign(new Error('the model call was stopped'), { code: 'ABORTED' })), { once: true });
  });
  const own = createAiPrograms({ piExec, chatPost: async () => ({}), voiceEndpoint: () => ({}), lm: () => 'openai-codex/gpt-x', logFolder: () => folder, live: w.live });
  const running = own.run('conversation_title', { opening_user_messages: ['x'] }, { signal: stop.signal });
  await new Promise(r => setTimeout(r, 20));
  stop.abort();
  await assert.rejects(running, e => e.code === 'ABORTED');
  await w.settle();
  const end = w.ops.find(o => o.op === 'end');
  assert.equal(end.state, 'cancelled');
  const [rec] = records();
  assert.equal(rec.error.type, 'Cancelled');
});

test('a document command is watched as the model writes it, leading space and all', async t => {
  const w = watcher();
  const reply = ' and then it rained.';
  const { programs } = setup(t, m => { m.stream = [' and then', ' it rained.']; return piReply(reply); }, { live: w.live });
  const command = aiCommands.commandById('sentence');
  const checked = aiCommands.validateRequest({ command: 'sentence', request: { scope: 'prose', target: { from: 11, to: 11, text: '' }, block: { type: 'prose', text: 'It was late' }, document: 'It was late' } }, 'document');
  const all = aiCommands.programInputs(command, checked.request, { path: 'notes.md', nonce: 'abcdef123456' });
  const inputs = Object.fromEntries((await programs.inputNames('doc_sentence')).map(k => [k, all[k]]));
  const pieces = [];
  await programs.run('doc_sentence', inputs, { onText: p => pieces.push(p), caller: { file: '/work/notes.md', user: 'maxime' } });
  await w.settle();
  assert.deepEqual(pieces, [' and then', ' it rained.']);
  const texts = w.ops.filter(o => o.op === 'text');
  assert.equal(texts.map(o => o.text).join(''), reply, 'the raw text, once: not again from FunctAI\u2019s reader');
  assert.deepEqual(w.ops.find(o => o.op === 'start').scope, { path: '/work/notes.md' });
});
