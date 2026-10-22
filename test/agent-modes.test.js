'use strict';
// Prompt modes for agents other than Pi (agent-modes.js): the words each
// agent receives, the marks readers show as a switch, and the record of
// what each agent has already been given.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modes = require('../agent-modes.js');

const PLAN = { key: 'plan', label: 'Plan', opener: 'Make a concise plan first.', appendix: 'Do not edit files unless asked.', removeSections: ['skills'], tools: ['read'] };
const WHOLE = { key: 'writer', label: 'Writer', systemPrompt: 'You write plain English.' };

test('a mode\'s words: under Pi\'s heading; a whole prompt is given as it is; Pi-only fields stay out', () => {
  assert.equal(modes.modeText(PLAN), '# Current prompt mode: Plan\nMake a concise plan first.\n\nDo not edit files unless asked.');
  assert.equal(modes.modeText(WHOLE), '# Current prompt mode: Writer\nYou write plain English.');
  assert.equal(modes.modeText(null), '');
  assert.doesNotMatch(modes.switchText(PLAN), /skills|read/);
});

test('a switch handed over as a message is marked, and read back as a switch', () => {
  const t = modes.switchText(PLAN);
  assert.match(t, /replaces any earlier one/);
  assert.deepEqual(modes.switchOf(t), { key: 'plan', label: 'Plan' });
  assert.deepEqual(modes.switchOf(modes.switchText(null)), { key: null, label: null });
  assert.equal(modes.switchOf('an ordinary developer message'), undefined);
  // Antigravity wraps an injected message in a line of its own first.
  assert.deepEqual(modes.switchOf('The following system message was injected by a PreInvocation hook:\n' + t), { key: 'plan', label: 'Plan' });
});

test('a mode before a person\'s message (Muse Code) comes off again when read', () => {
  const sent = modes.messagePrefix(PLAN) + 'fix the parser\nplease';
  assert.deepEqual(modes.splitMessage(sent), { text: 'fix the parser\nplease', mode: { key: 'plan', label: 'Plan' } });
  assert.deepEqual(modes.splitMessage('fix the parser'), { text: 'fix the parser', mode: undefined });
  // Quoting the mark later in a message is not a switch.
  const quoted = 'look at this: ' + modes.messagePrefix(PLAN);
  assert.equal(modes.splitMessage(quoted).mode, undefined);
});

test('the store: switches, what each agent was given, a new conversation\'s key, notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-modes-'));
  try {
    const file = path.join(dir, 'agent-modes.json');
    const s = modes.createAgentModes({ file });
    assert.equal(s.current('k'), null); assert.equal(s.has('k'), false); assert.equal(s.pending('k', 'codex'), false);
    // Back to no mode when there never was one: nothing recorded.
    s.set('k', null);
    assert.equal(s.has('k'), false);
    s.set('k', PLAN);
    assert.equal(s.current('k').key, 'plan');
    assert.equal(s.pending('k', 'codex'), true);
    s.given('k', 'codex');
    assert.equal(s.pending('k', 'codex'), false, 'given once');
    assert.equal(s.pending('k', 'muse'), true, 'each agent\'s way in counts on its own');
    // The same mode again is not a switch: nothing to hand over again.
    const id = s.current('k').id;
    s.set('k', { ...PLAN });
    assert.equal(s.current('k').id, id);
    assert.equal(s.pending('k', 'codex'), false);
    // A switch to none is one, to be handed over too.
    s.set('k', null);
    assert.equal(s.current('k').key, null);
    assert.equal(s.pending('k', 'codex'), true);
    assert.equal(s.publicState('k'), null);
    assert.equal(s.get('k').history.length, 2);
    // Kept on disk, moved with a new conversation's key, notes beside it.
    s.set('live:1', WHOLE); s.note('live:1', 'agyFile', '/x');
    s.rekey('live:1', 'agy:abc.db');
    const again = modes.createAgentModes({ file });
    assert.equal(again.current('agy:abc.db').key, 'writer');
    assert.equal(again.note('agy:abc.db', 'agyFile'), '/x');
    assert.equal(again.current('live:1'), null);
    // A note alone does not make a conversation "one with modes".
    again.note('other', 'agyFile', '/y');
    assert.equal(again.has('other'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Antigravity\'s hook: nothing without Chattering\'s file; the switch once; again only after a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-'));
  const { execFileSync } = require('node:child_process');
  const hook = path.join(__dirname, '..', 'harness', 'agy-mode-hook.js');
  const run = env => JSON.parse(execFileSync(process.execPath, [hook], { input: '{"conversationId":"c"}', env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  try {
    assert.deepEqual(run({}), {}, '`agy` used outside Chattering: nothing');
    const f = path.join(dir, 'mode.json');
    assert.deepEqual(run({ CHATTERING_MODE_FILE: f }), {}, 'no mode yet');
    fs.writeFileSync(f, JSON.stringify({ id: 'a', text: modes.switchText(PLAN) }));
    const first = run({ CHATTERING_MODE_FILE: f });
    assert.equal(modes.switchOf(first.injectSteps[0].systemMessage.systemMessage).key, 'plan');
    assert.deepEqual(run({ CHATTERING_MODE_FILE: f }), {}, 'given once');
    fs.writeFileSync(f, JSON.stringify({ id: 'b', text: modes.switchText(null) }));
    assert.match(run({ CHATTERING_MODE_FILE: f }).injectSteps[0].systemMessage.systemMessage, /no prompt mode from now on/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
