'use strict';
// Switching agent (harness/handoff.js, harness/chains.js): the conversation
// reduced to turns, written in each agent's own form, and the parts linked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../harness/handoff.js');
const { createChains } = require('../harness/chains.js');

const CONVERSATION = [
  { role: 'user', text: 'Find why the parser test fails.' },
  { role: 'thinking', text: 'secret reasoning' },
  { role: 'tool', name: 'bash', text: 'npm test', id: 't1' },
  { role: 'toolresult', tid: 't1', text: '1 failing: expected 3 got 2', err: true },
  { role: 'tool', name: 'edit', text: 'src/parse.js', writes: ['/w/src/parse.js'], id: 't2' },
  { role: 'toolresult', tid: 't2', text: 'ok' },
  { role: 'assistant', text: 'Fixed an off-by-one in parse.js.', agentName: 'Codex' },
  { role: 'user', text: 'Thanks.', images: [{}] },
  { role: 'user', text: 'Also add a test.' },
];

test('turns: words exact, work as notes, no reasoning, alternating, ending on an answer', () => {
  const { turns, left } = h.turnsOf(CONVERSATION);
  assert.equal(left, 0);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(turns[0].text, 'Find why the parser test fails.');
  assert.match(turns[1].text, /by Codex, carried over as notes; not run again/);
  assert.match(turns[1].text, /ran `npm test` → failed: 1 failing: expected 3 got 2/);
  assert.match(turns[1].text, /edited \/w\/src\/parse\.js/);
  assert.match(turns[1].text, /^\[Answer by Codex\]\n/);
  assert.match(turns[1].text, /Fixed an off-by-one in parse\.js\.$/);
  assert.doesNotMatch(JSON.stringify(turns), /secret reasoning/);
  assert.equal(turns[2].text, 'Thanks.\n\n[1 picture attached here; not carried over]\n\nAlso add a test.');
  assert.equal(turns[3].text, '(No answer was given to this message.)');
  // Copies already carried once are not carried again.
  assert.equal(h.turnsOf([{ role: 'user', text: 'x', carried: true }]).turns.length, 0);
});

test('turns over the budget: the newest kept, the person first, and it says what was left out', () => {
  const long = [];
  for (let i = 0; i < 10; i++) long.push({ role: 'user', text: 'q' + i + ' ' + 'x'.repeat(100) }, { role: 'assistant', text: 'a' + i + ' ' + 'y'.repeat(100) });
  const { turns, left } = h.turnsOf(long, { budget: 900 });
  assert.equal(turns[0].role, 'user');
  assert.ok(left > 0);
  assert.match(turns[0].text, new RegExp('^\\(' + left + ' earlier messages of this conversation left out'));
  assert.match(turns[turns.length - 1].text, /^a9 /);
});

test('Pi: a session file Pi resumes, every message marked as carried, the mode as Pi records it', () => {
  const { turns } = h.turnsOf(CONVERSATION);
  const lines = h.piSessionLines({ sessionId: 'S', cwd: '/w', turns, mode: { key: 'plan', label: 'Plan', appendix: 'Plan first.' }, from: 'codex:x' });
  assert.deepEqual(lines[0], { type: 'session', version: 3, id: 'S', timestamp: lines[0].timestamp, cwd: '/w' });
  const mode = lines[1];
  assert.equal(mode.customType, 'mode-switch');
  // The same checksum Pi's modes extension computes (canonical JSON).
  const canonical = '{"appendix":"Plan first.","key":"plan","label":"Plan"}';
  assert.equal(mode.data.sha256, require('node:crypto').createHash('sha256').update(canonical).digest('hex'));
  const msgs = lines.filter(l => l.type === 'message');
  assert.equal(msgs.length, 4);
  assert.ok(msgs.every(m => m.chatteringCarried === 'codex:x'));
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].parentId, i === 1 ? null : lines[i - 1].id);
  assert.equal(msgs[1].message.stopReason, 'stop');
});

test('Claude Code: its own entries, chained, marked as carried', () => {
  const { turns } = h.turnsOf(CONVERSATION);
  const lines = h.claudeSessionLines({ sessionId: 'S', cwd: '/w', turns, from: 'pi:x' });
  assert.deepEqual(lines.map(l => l.type), ['user', 'assistant', 'user', 'assistant', 'user']);
  // Last: who it was with, a hidden note (not a message the person wrote).
  assert.equal(lines[4].isMeta, true);
  assert.match(lines[4].message.content, /was with Codex; it continues with you, Claude Code\. Answers labelled \[Answer by …\] above were theirs/);
  assert.equal(lines[0].parentUuid, null);
  assert.equal(lines[1].parentUuid, lines[0].uuid);
  assert.equal(lines[0].message.content, 'Find why the parser test fails.');
  assert.equal(lines[1].message.content[0].type, 'text');
  assert.ok(lines.every(l => l.chatteringCarried === 'pi:x' && l.sessionId === 'S' && l.cwd === '/w'));
});

test('Codex: the history between two marks; Antigravity and Muse Code: a block taken off when read', () => {
  const { turns } = h.turnsOf(CONVERSATION);
  const items = h.codexItems(turns, { from: 'pi:x' });
  assert.equal(items.length, turns.length + 2);
  assert.equal(h.markOf(items[0].content[0].text).part, 'start');
  assert.equal(h.markOf(items[items.length - 1].content[0].text).part, 'end');
  assert.equal(items[1].role, 'user'); assert.equal(items[2].content[0].type, 'output_text');
  const block = h.promptBlock(turns, { from: 'pi:x', fromName: 'Pi', toName: 'Muse Code' });
  assert.match(block, /began with Pi and continues with you/);
  assert.deepEqual(h.splitPrompt(block + 'my new message'), { text: 'my new message', handoff: { from: 'pi:x', fromName: 'Pi', toName: 'Muse Code' } });
  assert.equal(h.splitPrompt('an ordinary message').handoff, undefined);
});

test('chains: parts linked, newest found, never a loop, a new part\'s key replaced, kept on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chains-'));
  try {
    const file = path.join(dir, 'chains.json');
    const c = createChains({ file });
    c.link('codex:b', 'pi:a', { from: 'pi', to: 'codex' });
    c.link('live:1', 'codex:b', { from: 'codex', to: 'muse' });
    assert.equal(c.newest('pi:a'), 'live:1');
    c.rekey('live:1', 'muse:c');
    assert.equal(c.newest('pi:a'), 'muse:c');
    assert.equal(c.prevOf('muse:c').key, 'codex:b');
    c.link('pi:a', 'muse:c');
    assert.equal(c.prevOf('pi:a'), null, 'no loop');
    const again = createChains({ file });
    assert.equal(again.nextOf('codex:b'), 'muse:c');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
