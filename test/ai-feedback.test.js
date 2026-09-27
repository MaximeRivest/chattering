'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeReport, FeedbackLog, TEXT_MAX } = require('../ai-feedback.js');

test('a command outcome keeps what was asked, every answer and what was kept', () => {
  const r = normalizeReport({
    kind: 'command', mode: 'review', decision: 'edited', ms: 1234.4, model: 'p/m', command: 'grammar', label: 'Fix grammar',
    target: 'Their going.', answers: [{ text: "They're going.", model: 'p/m', status: 'ready' }, { text: 'x', status: 'weird' }], shown: 0,
    review: { decision: 'edited', how: 'reviewed', hunks: [{ before: 'a\n', proposed: 'b\n', final: 'c\n', decision: 'edited' }], ms: 9 },
    user: 'mallory', answer: 'forged',
  });
  assert.equal(r.kind, 'command');
  assert.equal(r.ms, 1234);
  assert.deepEqual(r.answers.map(a => a.status), ['ready', 'error'], 'an unknown status is not kept as such');
  assert.deepEqual(r.review.hunks, [{ before: 'a\n', proposed: 'b\n', final: 'c\n', decision: 'edited' }]);
  assert.equal(r.user, undefined, 'the server says who');
  assert.equal(r.answer, undefined, 'the server says what the agent answered');
});

test('an ask outcome, bounded: long texts are cut with a marker, lists capped', () => {
  const r = normalizeReport({ kind: 'ask', decision: 'applied', mode: 'apply', prompt: 'shorter', diff: 'x'.repeat(TEXT_MAX + 10), include: { memory: 'yes' }, selection: { range: [3, 9, 12] } });
  assert.match(r.diff, /… \[10 more characters not kept\]$/);
  assert.deepEqual(r.include, { edits: true, asks: true, memory: false });
  assert.deepEqual(r.selection, { line: null, range: [3, 9] });
  assert.equal(r.command, undefined);
});

test('a report that is not one is refused', () => {
  assert.throws(() => normalizeReport({ kind: 'chat', decision: 'accepted' }), /kind/);
  assert.throws(() => normalizeReport({ kind: 'ask', decision: 'maybe' }), /unknown decision/);
});

test('the log appends one line per record and reads the newest back', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-feedback-')));
  try {
    const log = new FeedbackLog(path.join(dir, 'sub', 'ai-feedback.jsonl'));
    for (let i = 0; i < 5; i++) log.append({ i });
    assert.deepEqual(log.recent(2), [{ i: 3 }, { i: 4 }]);
    // Unix permission bits; Windows keeps it private by the per-user folder's access list.
    if (process.platform !== 'win32') assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
    assert.deepEqual(new FeedbackLog(path.join(dir, 'none.jsonl')).recent(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
