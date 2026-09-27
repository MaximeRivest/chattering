'use strict';
// A conversation before its first message: the browser-side draft store and
// the server pieces the first send relies on (instruction notes in the
// context bundle, the warm-process reuse rule, the start-folder description).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const plain = x => JSON.parse(JSON.stringify(x)); // values cross a vm context: compare structure, not prototypes

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function slice(source, startMarker, endMarker) {
  const a = source.indexOf(startMarker);
  assert.ok(a >= 0, 'missing ' + startMarker);
  const b = source.indexOf(endMarker, a);
  assert.ok(b > a, 'missing ' + endMarker);
  return source.slice(a, b);
}

// ---- server: context items, signature, bundle ----
function contextHarness() {
  const context = {
    crypto, path, Date, Map, Set, JSON, Number, String, Array, Object, Math,
    MEMORY_DOC_KINDS: ['overview', 'intent', 'environment', 'status'],
    currentIdentity: () => null, // no request: nothing to gate
    loadAttachedChat: async x => ({ text: 'exchange ' + (x.i ?? 'history') }),
    fsp: { writeFile: async () => {} }, BRIEFINGS_DIR: '/tmp',
    estimateInputTokens: x => x.length,
    projectMemoryDocument: async () => { throw new Error('no memory in this test'); },
    trustLabel: () => '', fileContextBlock: async () => 'file',
  };
  vm.createContext(context);
  vm.runInContext(slice(serverSource, 'function normalizeContextItems(', 'function conversationContextOf('), context);
  vm.runInContext(slice(serverSource, 'function contextSig(', 'function stopAnyWarmSession('), context);
  vm.runInContext(slice(serverSource, 'async function writeAttachedContextFile(', '// Wait for the session file'), context);
  return context;
}

test('instruction notes are context items: trimmed, capped, deduplicated, first in the bundle', async () => {
  const h = contextHarness();
  const items = h.normalizeContextItems([
    { type: 'note', text: '  Answer in French.\r\nBe terse.  ' },
    { type: 'note', text: 'Answer in French.\nBe terse.' }, // same text after normalization
    { type: 'note', text: '   ' },
    { type: 'chat', key: 'k', i: 2 },
  ]);
  assert.deepEqual(plain(items), [{ type: 'note', text: 'Answer in French.\nBe terse.' }, { type: 'chat', key: 'k', i: 2 }]);
  const out = await h.writeAttachedContextFile(items, { preview: true });
  assert.equal(out.notes, 1);
  assert.equal(out.chats, 1);
  const noteAt = out.text.indexOf('## Instructions for this conversation');
  const chatAt = out.text.indexOf('## Attached conversations');
  assert.ok(noteAt > 0 && chatAt > noteAt, 'instructions come before attached material');
  assert.ok(out.text.includes('Answer in French.\nBe terse.'));
  // A note alone is a valid bundle (no project memory or chat needed).
  const alone = await h.writeAttachedContextFile([{ type: 'note', text: 'Only this.' }], { preview: true });
  assert.equal(alone.notes, 1);
  const long = h.normalizeContextItems([{ type: 'note', text: 'x'.repeat(30000) }]);
  assert.equal(long[0].text.length, 20000);
});

test('the signature sees notes; the bundle hash ignores only the generation timestamp', async () => {
  const h = contextHarness();
  const a = h.contextSig([{ type: 'note', text: 'one' }]);
  const b = h.contextSig([{ type: 'note', text: 'two' }]);
  assert.notEqual(a, b);
  assert.equal(a, h.contextSig([{ type: 'note', text: 'one' }]));
  const first = await h.writeAttachedContextFile([{ type: 'note', text: 'same' }], { preview: true });
  await new Promise(r => setTimeout(r, 5));
  const second = await h.writeAttachedContextFile([{ type: 'note', text: 'same' }], { preview: true });
  const third = await h.writeAttachedContextFile([{ type: 'note', text: 'changed' }], { preview: true });
  assert.equal(h.contextBundleHash(first.text), h.contextBundleHash(second.text), 'identical content at two times hashes the same');
  assert.notEqual(h.contextBundleHash(first.text), h.contextBundleHash(third.text));
});

test('the warm process is kept only when the same chips render to the same text', () => {
  // The decision line from startAgentRun, checked in isolation.
  const decide = (prevApplied, nextCtxSig, ctxBundle, bundleHash) => {
    const prevCtxSig = prevApplied ? prevApplied.sig : '';
    const ctxChanged = prevCtxSig !== nextCtxSig;
    const sameBundle = !!prevApplied && prevApplied.sig === nextCtxSig && prevApplied.hash === bundleHash;
    return !!(ctxChanged || (ctxBundle && !sameBundle));
  };
  assert.equal(decide(null, '', null, ''), false, 'no context, nothing applied: keep');
  assert.equal(decide(null, 'note/a', { text: 'x' }, 'h1'), true, 'first send with context: (re)start');
  assert.equal(decide({ sig: 'note/a', hash: 'h1' }, 'note/a', { text: 'x' }, 'h1'), false, 'same chips, same text: keep');
  assert.equal(decide({ sig: 'note/a', hash: 'h1' }, 'note/a', { text: 'y' }, 'h2'), true, 'same chips, text moved on: restart');
  assert.equal(decide({ sig: 'note/a', hash: 'h1' }, '', null, ''), true, 'chips cleared: restart without the bundle');
});

// ---- server: what a start folder means ----
function folderHarness(home, projectNameOf) {
  const context = {
    fs, path, os: { homedir: () => home }, String, Boolean, Array, Object,
    expandHomePath: p => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p),
    projectNameOf, LOOSE_PROJECT: 'Loose conversations',
    PI_SETTINGS_FILE: path.join(home, '.pi', 'agent', 'settings.json'),
    projectMetaFor: name => (name === 'demo' ? { cwd: path.join(home, 'Projects', 'demo') } : null),
    areaOfCwdIn: () => null,
  };
  vm.createContext(context);
  vm.runInContext(slice(serverSource, 'function describeStartFolder(', '// What a fresh draft starts from'), context);
  return context;
}

test('describeStartFolder: existence, implied project, AGENTS.md files; the folder does not pick the model', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'draft-home-')));
  try {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.md'), '# global\n');
    fs.mkdirSync(path.join(home, 'Projects', 'demo', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Projects', 'demo', 'AGENTS.md'), '# demo\n');
    const projectNameOf = cwd => (cwd.startsWith(path.join(home, 'Projects', 'demo')) ? 'demo' : 'Loose conversations');
    const h = folderHarness(home, projectNameOf);
    const atHome = h.describeStartFolder('');
    assert.equal(atHome.path, home);
    assert.equal(atHome.display, '~');
    assert.equal(atHome.exists, true);
    assert.equal(atHome.loose, true);
    assert.equal(atHome.project, null);
    assert.deepEqual(plain(atHome.contextFiles), [path.join(home, '.pi', 'agent', 'AGENTS.md')]);
    assert.equal('defaultModel' in atHome, false, 'models follow the person, not the folder');
    const inProject = h.describeStartFolder('~/Projects/demo/sub');
    assert.equal(inProject.display, ['~', 'Projects', 'demo', 'sub'].join(path.sep), 'the home as ~, the rest as this system writes paths');
    assert.equal(inProject.loose, false);
    assert.equal(inProject.project, 'demo');
    assert.equal(inProject.known, true);
    assert.deepEqual(plain(inProject.contextFiles), [path.join(home, 'Projects', 'demo', 'AGENTS.md'), path.join(home, '.pi', 'agent', 'AGENTS.md')]);
    assert.equal('defaultModel' in inProject, false);
    const missing = h.describeStartFolder('~/nowhere');
    assert.equal(missing.exists, false);
    assert.equal(missing.contextFiles.length, 1, 'only the global file when the folder does not exist');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- server: which models a new conversation starts with ----
function modelPrefsHarness(piDefault) {
  const saves = [];
  const context = {
    String, Array, Object, JSON, Date, Set,
    modelPrefs: { conversations: {}, context: {}, last: {} },
    usersLib: { ownerOf: () => ({ id: 'owner' }) }, roster: {},
    readPiDefault: () => piDefault,
    saveModelPrefs: () => saves.push(JSON.stringify(context.modelPrefs.last)),
  };
  vm.createContext(context);
  vm.runInContext(slice(serverSource, 'function normalizePickedModel(', 'function saveModelPrefs('), context);
  vm.runInContext(slice(serverSource, '// Whose pick: a principal', 'function saveConversationModels('), context);
  return { ...context, saves };
}

test('a new conversation starts with the person\u2019s last pick; pi\u2019s default only before the first', () => {
  const h = modelPrefsHarness({ provider: 'pi', model: 'pi-default' });
  const start = h.newConversationModels({ user: { id: 'maxime' } });
  assert.deepEqual(plain(start), { models: [{ provider: 'pi', modelId: 'pi-default' }], source: 'pi' });
  const picked = [{ provider: 'a', modelId: 'one' }, { provider: 'b', modelId: 'two' }];
  h.rememberModelPick({ user: { id: 'maxime' } }, picked);
  assert.deepEqual(plain(h.newConversationModels({ user: { id: 'maxime' } })), { models: picked, source: 'last' }, 'every picked model carries over, not only the first');
  assert.deepEqual(plain(h.newConversationModels('maxime').models), picked, 'a bare user id reads the same pick');
  assert.equal(h.newConversationModels({ user: { id: 'lilly' } }).source, 'pi', 'one person\u2019s pick is not another\u2019s');
  // Without a person: the install owner's pick.
  h.rememberModelPick(null, [{ provider: 'c', modelId: 'owner-model' }]);
  assert.equal(h.newConversationModels(null).models[0].modelId, 'owner-model');
  assert.equal(h.newConversationModels({ user: { id: 'owner' } }).models[0].modelId, 'owner-model');
  // The same pick again writes nothing; an empty pick changes nothing.
  const before = h.saves.length;
  h.rememberModelPick({ user: { id: 'maxime' } }, picked);
  assert.equal(h.saves.length, before);
  assert.deepEqual(plain(h.rememberModelPick({ user: { id: 'maxime' } }, [])), []);
  assert.deepEqual(plain(h.newConversationModels('maxime').models), picked);
  // Nobody picked and pi has no default: no model, and the start says so.
  assert.deepEqual(plain(modelPrefsHarness({ provider: '', model: '' }).newConversationModels('x')), { models: [], source: null });
});

// ---- browser: the draft store ----
function draftHarness() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (String(v).length > 4 * 1024 * 1024) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const context = { localStorage, crypto, Date, Math, JSON, String, Array, Object, Map, Number, console, setTimeout, clearTimeout, current: null, activeRel: null, window: {}, document: { querySelector: () => null } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../conversation-draft.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// ---- the draft as the composer')), context);
  return { ...context, store };
}

test('a draft is saved only once it has content, is listed, and can be discarded', () => {
  const h = draftHarness();
  const d = h.newDraft();
  assert.match(d.id, /^[A-Za-z0-9_-]{6,64}$/);
  h.saveDraft(d);
  assert.equal(h.store.size, 0, 'an untouched draft leaves no trace');
  assert.equal(h.loadDraft(d.id), null);
  d.text = 'a thought';
  h.saveDraft(d);
  assert.equal(h.store.size, 1);
  const back = h.loadDraft(d.id);
  assert.equal(back.text, 'a thought');
  assert.deepEqual(plain(back.context), []);
  const listed = h.listDrafts();
  assert.equal(listed.length, 1);
  assert.equal(h.draftSummary(listed[0]), 'a thought');
  d.text = '';
  h.saveDraft(d);
  assert.equal(h.store.size, 0, 'emptied again: gone again');
  d.folder = '~/Projects/demo';
  h.saveDraft(d);
  assert.equal(h.draftHasContent(h.loadDraft(d.id)), true, 'a folder choice alone is content');
  h.deleteDraft(d.id);
  assert.equal(h.loadDraft(d.id), null);
});

test('images that do not fit the store stay in memory and the draft says so', () => {
  const h = draftHarness();
  const d = h.newDraft();
  d.text = 'with picture';
  d.images = [{ mime: 'image/png', data: 'x'.repeat(3 * 1024 * 1024), preview: '' }];
  h.saveDraft(d);
  assert.equal(d.imagesVolatile, true);
  const back = h.loadDraft(d.id);
  assert.equal(back.text, 'with picture');
  assert.equal(back.images.length, 1, 'served from memory while the page lives');
  const stored = JSON.parse(h.store.get('chattering.draft.v1:' + d.id));
  assert.equal(stored.images.length, 0, 'not in the store');
  const small = h.newDraft();
  small.text = 'small';
  small.images = [{ mime: 'image/png', data: 'abc', preview: '' }];
  h.saveDraft(small);
  assert.equal(small.imagesVolatile, false);
  assert.equal(JSON.parse(h.store.get('chattering.draft.v1:' + small.id)).images.length, 1);
});

test('stale drafts are dropped from the list; corrupt records are ignored', () => {
  const h = draftHarness();
  const old = h.newDraft();
  old.text = 'ancient';
  h.saveDraft(old);
  const raw = JSON.parse(h.store.get('chattering.draft.v1:' + old.id));
  raw.updatedAt = Date.now() - 61 * 86400000;
  h.store.set('chattering.draft.v1:' + old.id, JSON.stringify(raw));
  h.store.set('chattering.draft.v1:broken', '{not json');
  assert.deepEqual(plain(h.listDrafts()), []);
  assert.equal(h.store.has('chattering.draft.v1:' + old.id), false);
});
