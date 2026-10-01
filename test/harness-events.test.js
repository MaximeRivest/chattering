'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('../harness/claude-events.js');
const codex = require('../harness/codex-events.js');

const lines = f => fs.readFileSync(path.join(__dirname, 'fixtures', 'harness', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('Claude Code stream-json becomes a Pi run: text, one tool call, its result, the end', () => {
  const t = claude.createClaudeTranslator({ now: () => 0 });
  const events = lines('claude-stream-tool.jsonl').flatMap(r => t.push(r));
  const types = events.map(e => e.type);
  assert.equal(types.filter(x => x === 'message_start').length, 2, 'two model replies: before and after the tool');
  assert.equal(types.filter(x => x === 'message_end').length, 2);
  const start = events.find(e => e.type === 'tool_execution_start');
  assert.equal(start.toolName, 'Bash');
  assert.match(start.args.command, /echo hello-fixture/);
  const end = events.find(e => e.type === 'tool_execution_end');
  assert.equal(end.toolCallId, start.toolCallId);
  assert.equal(end.isError, false);
  assert.match(end.result.content[0].text, /hello-fixture/);
  const toolEnd = events.find(e => e.assistantMessageEvent && e.assistantMessageEvent.type === 'toolcall_end');
  assert.equal(toolEnd.assistantMessageEvent.toolCall.id, start.toolCallId, 'the streamed call and the run are one card');
  const ends = events.filter(e => e.type === 'message_end');
  assert.equal(ends[0].message.stopReason, 'toolUse');
  assert.ok(ends[1].message.content.some(c => c.type === 'text' && c.text.length > 0), 'the final answer has text');
  assert.equal(ends[1].message.provider, 'claude-code');
  assert.match(ends[1].message.model, /claude/);
  const agentEnd = events.at(-1);
  assert.equal(agentEnd.type, 'agent_end');
  assert.equal(agentEnd.failed, false);
  assert.ok(agentEnd.cost > 0);
  assert.ok(events.some(e => e.type === 'harness_limits'), 'plan usage is reported');
  // The streamed text equals the final text: nothing is lost between deltas and the end.
  const deltas = events.filter(e => e.assistantMessageEvent && e.assistantMessageEvent.type === 'text_delta').map(e => e.assistantMessageEvent.delta).join('');
  const finals = ends.flatMap(e => e.message.content).filter(c => c.type === 'text').map(c => c.text).join('');
  assert.equal(deltas, finals);
});

test('Claude Code: a failed result ends the run with the error', () => {
  const t = claude.createClaudeTranslator();
  const out = t.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's' });
  assert.equal(out[0].message.stopReason, 'error');
  assert.match(out[0].message.errorMessage, /boom/);
  assert.equal(out[1].type, 'agent_end');
  assert.equal(out[1].failed, true);
});

test('Claude Code: a helper agent streams into its parent tool card, never as a message', () => {
  const t = claude.createClaudeTranslator();
  const a = t.push({ type: 'stream_event', parent_tool_use_id: 'toolu_p', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look' } } });
  const b = t.push({ type: 'stream_event', parent_tool_use_id: 'toolu_p', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing' } } });
  assert.equal(a[0].type, 'tool_execution_update');
  assert.equal(b[0].partialResult.content[0].text, 'looking');
  assert.equal(t.push({ type: 'stream_event', parent_tool_use_id: 'toolu_p', event: { type: 'message_start', message: {} } }).length, 0);
});

test('Claude Code permission: the dialog and each answer', () => {
  const req = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write',
    input: { file_path: '/p/made.txt', content: 'ok' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } };
  const d = claude.permissionDialog(req);
  assert.equal(d.type, 'extension_ui_request');
  assert.equal(d.method, 'select');
  assert.match(d.message, /made\.txt/);
  assert.deepEqual(d.options, [claude.ALLOW, claude.DENY], 'broad permission suggestions are not disguised as session-only approval');
  const allow = claude.toPermissionResponse(req, { value: claude.ALLOW }).response;
  assert.equal(allow.request_id, 'r1');
  assert.equal(allow.response.behavior, 'allow');
  assert.deepEqual(allow.response.updatedInput, req.request.input);
  assert.equal(allow.response.updatedPermissions, undefined);
  assert.equal(claude.toPermissionResponse(req, { value: claude.ALLOW_ALWAYS }).response.response.behavior, 'deny', 'only offered choices can approve');
  assert.equal(claude.toPermissionResponse(req, { value: claude.DENY }).response.response.behavior, 'deny');
  assert.equal(claude.toPermissionResponse(req, { cancelled: true }).response.response.behavior, 'deny', 'no answer is a refusal');
  assert.deepEqual(claude.permissionDialog({ request_id: 'r2', request: { tool_name: 'Read', input: { file_path: 'x' } } }).options, [claude.ALLOW, claude.DENY], 'no suggestion, no "always"');
});

test('Codex app-server becomes a Pi run: the command, its output, the answer, the end', () => {
  const t = codex.createCodexTranslator({ now: () => 0, model: 'gpt-test' });
  const rpcs = lines('codex-appserver-tool.jsonl');
  const events = rpcs.flatMap(r => t.push(r));
  const start = events.find(e => e.type === 'tool_execution_start');
  assert.equal(start.toolName, 'shell');
  assert.equal(start.args.command, 'echo hello-fixture');
  const end = events.find(e => e.type === 'tool_execution_end');
  assert.equal(end.toolCallId, start.toolCallId);
  assert.equal(end.isError, false);
  assert.match(end.result.content[0].text, /hello-fixture/);
  const texts = events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').flatMap(e => e.message.content).filter(c => c.type === 'text').map(c => c.text);
  assert.ok(texts.length >= 1 && texts.every(Boolean), 'every agent message ends with its text');
  const deltas = events.filter(e => e.assistantMessageEvent && e.assistantMessageEvent.type === 'text_delta').map(e => e.assistantMessageEvent.delta).join('');
  assert.equal(deltas, texts.join(''), 'the streamed words are the final words');
  assert.ok(events.every(e => e.type !== 'message_update' || events.indexOf(e) > events.findIndex(x => x.type === 'message_start')), 'no update before a message starts');
  const user = events.find(e => e.type === 'message_end' && e.message.role === 'user');
  assert.match(user.message.content[0].text, /echo hello-fixture/);
  const last = events.at(-1);
  assert.equal(last.type, 'agent_end');
  assert.equal(last.failed, false);
  // The approval request in the recording becomes a dialog.
  const ask = rpcs.find(r => codex.APPROVAL_METHODS.has(r.method));
  const d = codex.approvalDialog(ask);
  assert.equal(d.title, 'Codex wants to run a command');
  assert.match(d.message, /echo hello-fixture/);
  assert.deepEqual(codex.toApprovalResult(ask, { value: codex.ALLOW }).result, { decision: 'accept' });
  assert.deepEqual(codex.toApprovalResult(ask, { value: codex.ALLOW_ALWAYS }).result, { decision: 'acceptForSession' });
  assert.deepEqual(codex.toApprovalResult(ask, { value: codex.STOP }).result, { decision: 'cancel' });
  assert.deepEqual(codex.toApprovalResult(ask, { cancelled: true }).result, { decision: 'decline' });
  assert.deepEqual(codex.toApprovalResult({ id: 3, method: 'execCommandApproval' }, { value: codex.ALLOW }).result, { decision: 'approved' });
});

test('Codex: reasoning streams as thinking; an interrupted turn ends as aborted', () => {
  const t = codex.createCodexTranslator({ model: 'm' });
  const a = t.push({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'rs1', delta: 'Plan' } });
  assert.equal(a[0].type, 'message_start');
  assert.equal(a[1].assistantMessageEvent.type, 'thinking_delta');
  const end = t.push({ method: 'turn/completed', params: { turn: { id: 't', status: 'interrupted' } } });
  const thinking = end.find(e => e.type === 'message_end' && e.message.content[0] && e.message.content[0].type === 'thinking');
  assert.equal(thinking.message.content[0].thinking, 'Plan');
  const aborted = end.find(e => e.type === 'message_end' && e.message.stopReason === 'aborted');
  assert.ok(aborted);
  assert.equal(end.at(-1).interrupted, true);
});
