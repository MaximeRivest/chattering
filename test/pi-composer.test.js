'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPiComposer, commandsOf, editorState } = require('../harness/pi-composer');
const tick = () => new Promise(r => setImmediate(r));
function setup(options = {}) {
  const s = { sessionManager: { getCwd: () => '/workspace' },
    extensionRunner: { getRegisteredCommands: () => [{ name: 'choose', invocationName: 'choose', description: 'Pick', getArgumentCompletions: async p => [{ value: p + 'value', label: 'choice', privateData: 42 }] }] },
    promptTemplates: [{ name: 'draft', description: 'Template' }], settingsManager: { getEnableSkillCommands: () => true },
    resourceLoader: { getSkills: () => ({ skills: [{ name: 'skill-one', description: 'Skill' }] }) },
  };
  class Provider {
    constructor(commands, cwd) { this.commands = commands; assert.equal(cwd, '/workspace'); }
    async getSuggestions(lines, row, col, opts) {
      if (options.suggest) return options.suggest(lines[row], opts.signal);
      const c = this.commands.find(c => lines[row].startsWith('/' + c.name + ' '));
      const prefix = lines[row].slice(0, col).split(' ').slice(1).join(' ');
      return c ? { prefix, items: await c.getArgumentCompletions(prefix) } : { prefix: lines[row], items: [{ value: '@"dir name/"', label: 'dir name/' }] };
    }
    applyCompletion(lines, row, col, item) {
      if (item.privateData) assert.equal(item.privateData, 42);
      return { lines: lines.map((l, i) => i === row ? item.value + l.slice(col) : l), cursorLine: row, cursorCol: item.value.length - 1 };
    }
  }
  return { s, composer: createPiComposer({ session: () => s, load: async () => ({ CombinedAutocompleteProvider: Provider, fdPath: null }), ...options }) };
}
const input = (text, extra = {}) => ({ action: 'complete', clientId: 'tab-a', text, cursor: text.length, ...extra });

test('live registry includes commands, templates, and enabled skills; no functions cross IPC', () => {
  const { s, composer } = setup();
  assert.deepEqual(composer.commands().filter(c => c.source !== 'builtin').map(c => [c.name, c.source]), [['choose','extension'], ['draft','prompt'], ['skill:skill-one','skill']]);
  assert.ok(composer.commands().some(c => c.name === 'model' && c.source === 'builtin'));
  assert.equal(composer.commands().find(c => c.name === 'choose').getArgumentCompletions, undefined);
  assert.equal(typeof commandsOf(s).find(c => c.name === 'choose').getArgumentCompletions, 'function');
  s.promptTemplates.push({ name: 'new-template' });
  assert.ok(composer.commands().some(c => c.name === 'new-template'));
  s.settingsManager.getEnableSkillCommands = () => false;
  assert.ok(!composer.commands().some(c => c.source === 'skill'));
});

test('extension arguments and provider-owned edits preserve multiline cursor and private item data', async () => {
  const { composer } = setup();
  const q = input('before\n/choose blueafter', { cursor: 'before\n/choose blue'.length });
  const result = await composer.complete(q);
  assert.equal(result.items[0].privateData, undefined);
  assert.equal(result.items[0].value, 'bluevalue');
  const edit = await composer.apply({ ...q, snapshot: result.snapshot, itemIndex: 0 });
  assert.equal(edit.text, 'before\nbluevalueafter');
  assert.equal(edit.cursor, 'before\nbluevalue'.length - 1);
  await assert.rejects(composer.apply({ ...q, snapshot: result.snapshot, itemIndex: 0 }), /expired/);
});

test('extension wrappers add their trigger, completion and exact insertion semantics', async () => {
  const { composer } = setup();
  let applied = 0;
  composer.addProvider(base => ({ triggerCharacters: ['#'],
    getSuggestions: async () => ({ prefix: '#c', items: [{ value: 'cell', label: 'cell one', cellId: 7 }] }),
    applyCompletion: (lines, row, col, item) => { applied++; assert.equal(item.cellId, 7); return { lines: ['attached cell 7'], cursorLine: 0, cursorCol: 8 }; },
  }));
  const q = input('#c'), r = await composer.complete(q);
  assert.equal(applied, 0, 'opening a menu must not apply all completions');
  const e = await composer.apply({ ...q, snapshot: r.snapshot, itemIndex: 0 });
  assert.equal(e.text, 'attached cell 7'); assert.equal(e.cursor, 8); assert.equal(applied, 1);
  composer.reset();
  assert.deepEqual((await composer.complete(q)).items, []);
});

test('plain prose does not open a directory menu, while force can', async () => {
  const { composer } = setup();
  assert.deepEqual((await composer.complete(input('ordinary prose '))).items, []);
  assert.equal((await composer.complete(input('ordinary prose ', { force: true }))).items.length, 1);
});

test('completion cannot overwrite changed text, move a different caret, or be applied by another editor', async () => {
  const { composer } = setup(); const q = input('@dir'), r = await composer.complete(q);
  for (const patch of [{ text: '@other' }, { cursor: 0 }, { clientId: 'tab-b' }, { itemIndex: -1 }]) {
    await assert.rejects(composer.apply({ ...q, snapshot: r.snapshot, itemIndex: 0, ...patch }), /expired/);
  }
  composer.reset();
  await assert.rejects(composer.apply({ ...q, snapshot: r.snapshot, itemIndex: 0 }), /expired/);
});

test('new queries cancel older ones without blocking other tabs or trusting late results', async () => {
  const requests = [];
  const { composer } = setup({ suggest: (line, signal) => new Promise(resolve => requests.push({ line, signal, resolve })) });
  const a = composer.complete(input('@a')); await tick();
  const b = composer.complete(input('@b')); await tick();
  assert.equal(requests[0].signal.aborted, true); assert.deepEqual((await a).items, []);
  const other = composer.complete(input('@other', { clientId: 'tab-b' })); await tick();
  assert.equal(requests[1].signal.aborted, false);
  requests[1].resolve({ prefix: '@b', items: [{ value: 'b', label: 'b' }] });
  requests[2].resolve({ prefix: '@other', items: [{ value: 'other', label: 'other' }] });
  const rb = await b; assert.equal(rb.items[0].value, 'b'); assert.equal((await other).items[0].value, 'other');
  requests[0].resolve({ prefix: '@a', items: [{ value: 'a', label: 'a' }] }); await tick();
  assert.ok((await composer.apply({ ...input('@b'), snapshot: rb.snapshot, itemIndex: 0 })).text.startsWith('b'));
});

test('stalled extension completion times out; expired edits and malformed provider edits are rejected', async () => {
  const { composer } = setup({ timeoutMs: 15, suggest: () => new Promise(() => {}) });
  assert.deepEqual((await composer.complete(input('/choose x'))).items, []);
  let clock = 0;
  const c = setup({ now: () => clock }).composer;
  const q = input('@x'), r = await c.complete(q); clock = 61000;
  await assert.rejects(c.apply({ ...q, snapshot: r.snapshot, itemIndex: 0 }), /expired/);
  c.addProvider(base => ({ getSuggestions: base.getSuggestions.bind(base), applyCompletion: () => ({ lines: ['x'], cursorLine: 0, cursorCol: 20 }) }));
  const r2 = await c.complete(q);
  await assert.rejects(c.apply({ ...q, snapshot: r2.snapshot, itemIndex: 0 }), /invalid completion/);
});

test('input bounds include UTF-16 positions used by HTML textareas and Pi', () => {
  assert.deepEqual(editorState({ text: '🦙\n@x', cursor: 5 }), { text: '🦙\n@x', cursor: 5, lines: ['🦙','@x'], cursorLine: 1, cursorCol: 2 });
  assert.throws(() => editorState({ text: '', cursor: -1 }), /cursor/);
  assert.throws(() => editorState({ text: 'x'.repeat(65537) }), /large/);
});
