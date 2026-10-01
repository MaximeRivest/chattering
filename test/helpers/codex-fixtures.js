'use strict';
// Synthetic Codex conversation files in each generation's real shape
// (measured on 241 real files, 2026-09-30; no real content is copied).
const fs = require('node:fs');
const path = require('node:path');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0V8AAAAASUVORK5CYII=';
let ordinal = 0;
const line = (ts, type, payload) => JSON.stringify({ timestamp: ts, ordinal: ordinal++, type, payload });

// Generation 3: the current JSONL (session_meta, turn_context, response_item, event_msg).
function currentRollout(cwd, id = '01a0f000-0000-7000-8000-000000000001') {
  ordinal = 0;
  const t = s => '2026-09-20T10:00:' + String(s).padStart(2, '0') + '.000Z';
  return [
    line(t(0), 'session_meta', { id, session_id: id, timestamp: t(0), cwd, originator: 'codex-tui', cli_version: '0.153.4', source: 'cli', model_provider: 'openai', git: { branch: 'main' } }),
    line(t(0), 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    line(t(1), 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>sandbox rules</permissions instructions>' }] }),
    line(t(1), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for ' + cwd + '\nbe brief' }] }),
    line(t(1), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>' + cwd + '</cwd>\n</environment_context>' }] }),
    line(t(1), 'turn_context', { turn_id: 'turn-1', cwd, model: 'gpt-fixture', effort: 'low' }),
    line(t(2), 'event_msg', { type: 'user_message', message: '# Context from my IDE setup:\n\n## Active file: src/app.ts\n\n## My request for Codex:\nWhy does the parrot fixture fail?', images: ['data:image/png;base64,' + PNG], local_images: [] }),
    line(t(2), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## Active file: src/app.ts\n\n## My request for Codex:\nWhy does the parrot fixture fail?' }] }),
    line(t(3), 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Checking the tests**' }], encrypted_content: 'sealed' }),
    line(t(4), 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test -- parrot', workdir: cwd }), call_id: 'call_exec' }),
    line(t(5), 'response_item', { type: 'function_call_output', call_id: 'call_exec', output: 'Chunk ID: 1\nWall time: 0.2 seconds\nProcess exited with code 1\nOutput:\nparrot: expected squawk' }),
    line(t(6), 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/parrot.js\n@@\n-quack\n+squawk\n*** End Patch' }),
    line(t(7), 'response_item', { type: 'custom_tool_call_output', call_id: 'call_patch', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/parrot.js\n', metadata: { exit_code: 0 } }) }),
    line(t(8), 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The parrot said quack; it now says squawk.' }] }),
    line(t(8), 'event_msg', { type: 'agent_message', message: 'The parrot said quack; it now says squawk.' }),
    line(t(9), 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 }, model_context_window: 200000 } }),
    // Codex emits some counts twice: the second must not count again.
    line(t(9), 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 }, model_context_window: 200000 } }),
    line(t(9), 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
    line(t(10), 'event_msg', { type: 'task_started', turn_id: 'turn-2' }),
    line(t(10), 'turn_context', { turn_id: 'turn-2', cwd, model: 'gpt-fixture', effort: 'high' }),
    line(t(11), 'event_msg', { type: 'user_message', message: '<realtime_delegation>\n  <input>Can you also check the owl fixture?</input>\n</realtime_delegation>', images: [] }),
    line(t(12), 'event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    line(t(13), 'compacted', { message: '', replacement_history: [] }),
    line(t(14), 'event_msg', { type: 'user_message', message: 'What is left?', images: [] }),
    line(t(15), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Only the owl.' }] }),
    line(t(16), 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1800, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 1880 }, last_token_usage: { input_tokens: 800, cached_input_tokens: 400, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 830 }, model_context_window: 200000 } }),
  ].join('\n') + '\n';
}

// Generation 2: early JSONL (header, state markers, raw items, no timestamps).
function earlyRollout(cwd, id = 'a0000000-0000-4000-8000-000000000002') {
  return [
    JSON.stringify({ id, timestamp: '2025-08-21T12:52:33.287Z', instructions: null, git: { branch: 'main' } }),
    JSON.stringify({ record_type: 'state' }),
    JSON.stringify({ type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: '<environment_context>\nCurrent working directory: ' + cwd + '\n</environment_context>' }] }),
    JSON.stringify({ type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'List the heron files' }] }),
    JSON.stringify({ type: 'function_call', id: 'fc_1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls herons'], timeout: 120000 }), call_id: 'call_ls' }),
    JSON.stringify({ type: 'function_call_output', call_id: 'call_ls', output: JSON.stringify({ output: 'heron.md\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) }),
    JSON.stringify({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'One heron file: heron.md' }] }),
    JSON.stringify({ record_type: 'state' }),
  ].join('\n') + '\n';
}

// Generation 1: one JSON document.
function legacyJson(cwd, id = 'b0000000-0000-4000-8000-000000000003') {
  return JSON.stringify({ session: { timestamp: '2025-07-05T16:48:14.511Z', id, instructions: '' }, items: [
    { role: 'user', content: [{ type: 'input_text', text: 'what folders are there' }], type: 'message' },
    { id: 'rs_1', type: 'reasoning', summary: [], duration_ms: 10 },
    { type: 'local_shell_call', status: 'completed', call_id: 'call_ls', action: { type: 'exec', command: ['bash', '-lc', 'ls'] } },
    { type: 'function_call_output', call_id: 'call_ls', output: JSON.stringify({ output: 'docs\nsrc\n', metadata: { exit_code: 0 } }) },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two folders: docs and src.' }] },
  ] });
}

// A Codex fork (thread/fork, 0.153): the file refers to its original's
// history before an ordinal instead of copying it (measured 2026-09-30).
function forkedRollout(cwd, parentId, untilOrdinal, id = '01a0f000-0000-7000-8000-00000000f0f0') {
  ordinal = untilOrdinal;
  const t = s => '2026-09-22T10:00:' + String(s).padStart(2, '0') + '.000Z';
  return [
    line(t(0), 'session_meta', { session_id: id, id, forked_from_id: parentId, forked_from_ordinal_exclusive: untilOrdinal, timestamp: t(0), cwd, originator: 'chattering', cli_version: '0.153.4', source: 'appServer', model_provider: 'openai' }),
    line(t(1), 'event_msg', { type: 'task_started', turn_id: 'turn-f1' }),
    line(t(1), 'turn_context', { turn_id: 'turn-f1', cwd, model: 'gpt-fixture', effort: 'medium' }),
    line(t(2), 'event_msg', { type: 'user_message', message: 'In this branch, try the heron instead', images: [] }),
    line(t(3), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The heron fixture passes.' }] }),
  ].join('\n') + '\n';
}

// A Codex desktop import of a Claude Code conversation (text only).
function importedCopy(cwd, firstMessage, id = '01a0f000-0000-7000-8000-000000000004') {
  const t = s => '2026-09-21T09:00:' + String(s).padStart(2, '0') + '.000Z';
  return [
    line(t(0), 'session_meta', { id, session_id: id, timestamp: t(0), cwd, originator: 'Codex Desktop', cli_version: '0.147.0', source: 'vscode', model_provider: 'openai' }),
    line(t(0), 'event_msg', { type: 'task_started', turn_id: 'external-import-turn-1' }),
    line(t(0), 'event_msg', { type: 'user_message', message: '<command-name>/login</command-name>' }),
    line(t(0), 'event_msg', { type: 'task_started', turn_id: 'external-import-turn-2' }),
    line(t(0), 'event_msg', { type: 'user_message', message: firstMessage }),
    line(t(0), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstMessage }] }),
    line(t(0), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A copied answer.' }] }),
    line(t(0), 'event_msg', { type: 'agent_message', message: '<EXTERNAL SESSION IMPORTED>' }),
  ].join('\n') + '\n';
}

function writeCodexHome(home, cwd) {
  const dir = path.join(home, '.codex', 'sessions');
  const at = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return {
    current: at('2026/09/20/rollout-2026-09-20T10-00-00-01a0f000-0000-7000-8000-000000000001.jsonl', currentRollout(cwd)),
    early: at('2025/08/21/rollout-2025-08-21T12-52-33-a0000000-0000-4000-8000-000000000002.jsonl', earlyRollout(cwd)),
    legacy: at('rollout-2025-07-05-b0000000-0000-4000-8000-000000000003.json', legacyJson(cwd)),
    imported: at('2026/09/21/rollout-2026-09-21T09-00-00-01a0f000-0000-7000-8000-000000000004.jsonl', importedCopy(cwd, 'Explain the kestrel parser')),
    // A fork of `current`, made after its first answer (ordinal 15 is the turn-1 token_count line).
    forked: at('2026/09/22/rollout-2026-09-22T10-00-00-01a0f000-0000-7000-8000-00000000f0f0.jsonl', forkedRollout(cwd, '01a0f000-0000-7000-8000-000000000001', 17)),
  };
}

module.exports = { currentRollout, earlyRollout, legacyJson, importedCopy, forkedRollout, writeCodexHome, PNG };
