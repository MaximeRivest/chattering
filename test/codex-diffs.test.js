'use strict';
// Codex's file edits read as Chattering edits (harness/codex-diffs.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePatch, patchesIn, codexEditOps, outcomeOf } = require('../harness/codex-diffs');

const rec = (type, payload, ts = '2026-09-01T10:00:00Z') => ({ timestamp: ts, type, payload });

test('a patch: updates by hunk (context kept on both sides), new files whole, deletions, moves', () => {
  const files = parsePatch([
    '*** Begin Patch',
    '*** Update File: src/a.js',
    '@@ function one',
    ' keep',
    '-old one',
    '+new one',
    '@@',
    '-gone',
    '+here',
    '+and here',
    '',
    ' tail',
    '*** End of File',
    '*** Add File: docs/new.md',
    '+# New',
    '+text',
    '*** Delete File: old.txt',
    '*** Update File: b.js',
    '*** Move to: lib/b.js',
    '@@',
    '-x',
    '+y',
    '*** End Patch',
  ].join('\n'));
  assert.deepEqual(files.map(f => [f.op, f.path, f.moveTo]), [['update', 'src/a.js', null], ['add', 'docs/new.md', null], ['delete', 'old.txt', null], ['update', 'b.js', 'lib/b.js']]);
  assert.deepEqual(files[0].hunks, [{ oldText: 'keep\nold one', newText: 'keep\nnew one' }, { oldText: 'gone\n\ntail', newText: 'here\nand here\n\ntail' }]);
  assert.equal(files[1].content, '# New\ntext\n');
});

test('several patches in one shell script are all found', () => {
  const script = "cd x && apply_patch <<'P'\n*** Begin Patch\n*** Add File: a\n+1\n*** End Patch\nP\napply_patch <<'Q'\n*** Begin Patch\n*** Add File: b\n+2\n*** End Patch\nQ";
  assert.equal(patchesIn(script).length, 2);
});

test('outcomes: success, verification failure, exit codes', () => {
  assert.equal(outcomeOf('Success. Updated the following files:\nM a'), 'applied');
  assert.equal(outcomeOf('apply_patch verification failed: Failed to find expected lines'), 'failed');
  assert.equal(outcomeOf('Process exited with code 1\nOutput:'), 'failed');
  assert.equal(outcomeOf('Process exited with code 0'), 'applied');
});

test('current files: relative paths from the turn folder, workdir honoured, outcome from the output or the apply event', () => {
  const ops = codexEditOps([
    rec('session_meta', { id: 's', cwd: '/w' }),
    rec('turn_context', { cwd: '/w/proj' }),
    rec('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.js\n@@\n-1\n+2\n*** End Patch' }),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: 'apply_patch verification failed: nope' }) }),
    rec('response_item', { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: "apply_patch <<'E'\n*** Begin Patch\n*** Add File: n.txt\n+hi\n*** End Patch\nE", workdir: 'sub' }) }),
    rec('event_msg', { type: 'patch_apply_end', call_id: 'c2', success: true }),
    rec('response_item', { type: 'function_call', call_id: 'c3', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls' }) }),
  ]);
  assert.deepEqual(ops.map(o => [o.callId, o.path, o.kind, o.outcome]), [['c1', '/w/proj/a.js', 'edit', 'failed'], ['c2', '/w/proj/sub/n.txt', 'write', 'applied']]);
});

test('early files: raw items, the folder from Codex\'s environment note', () => {
  const ops = codexEditOps([
    { id: 's', timestamp: '2025-08-25T09:50:03Z', instructions: null },
    { record_type: 'state' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\nCurrent working directory: /home/p/att\n</environment_context>' }] },
    { type: 'function_call', call_id: 'c', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', "apply_patch << 'PATCH'\n*** Begin Patch\n*** Update File: x.py\n@@\n-a\n+b\n*** End Patch\nPATCH"] }) },
    { type: 'function_call_output', call_id: 'c', output: JSON.stringify({ output: 'Done!', metadata: { exit_code: 0 } }) },
  ]);
  assert.deepEqual(ops.map(o => [o.path, o.oldText, o.newText, o.outcome]), [['/home/p/att/x.py', 'a', 'b', 'applied']]);
});
