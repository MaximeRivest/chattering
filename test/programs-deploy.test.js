'use strict';
// programs-deploy.js: programs made in Chattering (design/75), without a
// server: definitions checked, a caller's inputs checked against them, the
// registry of published copies and keys, the per-key limit, and what a
// caller is told.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const d = require('../programs-deploy.js');

const team = () => ({
  name: 'team', description: 'Which team should answer this customer message?',
  inputs: [{ name: 'message', shape: { type: 'string' }, desc: 'what the customer wrote' }],
  outputs: [{ name: 'result', shape: { enum: ['shipping', 'billing'], type: 'string' } }],
});

test('a definition is checked and put in FunctAI\u2019s form', () => {
  const def = d.normalizeDefinition({ ...team(), outputs: [{ name: 'result', shape: { enum: [' shipping ', 'billing'], type: 'string', description: 'x' } }] });
  // A note written inside the shape (as TypeScript's t.string({description}) does) becomes the field's note.
  assert.deepEqual(def, { ...team(), outputs: [{ ...team().outputs[0], desc: 'x' }], settings: {}, state: { instructions: null, demos: [] } });
  const bad = (change, re) => assert.throws(() => d.normalizeDefinition({ ...team(), ...change }), re);
  bad({ name: 'Team' }, /lowercase/);
  bad({ name: '1team' }, /lowercase/);
  bad({ inputs: [] }, /at least one input/);
  bad({ outputs: [] }, /at least one answer/);
  bad({ inputs: [{ name: 'result', shape: { type: 'string' } }] }, /used twice/);
  bad({ inputs: [{ name: 'my message', shape: { type: 'string' } }] }, /not a name/);
  bad({ outputs: [{ name: 'result', shape: { enum: [], type: 'string' } }] }, /at least one answer/);
  bad({ outputs: [{ name: 'result', shape: { enum: ['a', 'a'], type: 'string' } }] }, /repeat/);
  bad({ outputs: [{ name: 'result', shape: { type: 'date' } }] }, /not a type/);
  bad({ outputs: [{ name: 'result', shape: { anyOf: [{ type: 'string' }, { type: 'number' }] } }] }, /optional/);
  // Records, maps, lists and optional values: every shape FunctAI reads.
  const rich = d.normalizeDefinition({ ...team(), outputs: [{ name: 'result', shape: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } }, score: { anyOf: [{ type: 'number' }, { type: 'null' }] } } } }] });
  assert.deepEqual(rich.outputs[0].shape.required, ['tags', 'score']);
});

test('what a caller sends is checked against the inputs, every problem at once', () => {
  const def = d.normalizeDefinition({ ...team(), inputs: [
    { name: 'message', shape: { type: 'string' } }, { name: 'priority', shape: { type: 'integer' } },
    { name: 'tags', shape: { type: 'array', items: { enum: ['vip', 'new'], type: 'string' } } }, { name: 'note', shape: { anyOf: [{ type: 'string' }, { type: 'null' }] } }] });
  assert.deepEqual(d.checkInputs(def, { message: 'hi', priority: 2, tags: ['vip'] }), { message: 'hi', priority: 2, tags: ['vip'], note: null }, 'an optional input may be left out');
  const e = (() => { try { d.checkInputs(def, { message: 3, priority: 1.5, tags: ['old'], extra: 1 }); } catch (err) { return err; } })();
  assert.equal(e.status, 400);
  assert.equal(e.code, 'bad-inputs');
  assert.deepEqual(e.problems, ['extra is not an input (the inputs are message, priority, tags, note)', 'message is text', 'priority is a whole number', 'tags[0] is one of "vip", "new"']);
  assert.throws(() => d.checkInputs(def, ['hi']), /JSON object/);
  assert.throws(() => d.checkInputs(def, {}), /message is missing/);
});

test('the kinds a person picks are FunctAI shapes', () => {
  assert.deepEqual(d.shapeOfKind('choice', ['a', ' b ', '']), { enum: ['a', 'b'], type: 'string' });
  assert.deepEqual(d.shapeOfKind('whole number'), { type: 'integer' });
  assert.deepEqual(d.shapeOfKind('yes/no'), { type: 'boolean' });
  assert.deepEqual(d.shapeOfKind('list'), { type: 'array', items: { type: 'string' } });
  assert.deepEqual(d.shapeOfKind('anything else'), { type: 'string' });
});

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-28T12:00:00Z');
  const make = () => d.createRegistry({ file: path.join(root, 'registry.json'), versionsDir: path.join(root, 'published'), now: () => clock });
  const folder = path.join(root, 'work', 'programs', 'team');
  d.writeSource(folder, d.normalizeDefinition(team()), { functai_saved: 1, nodes: { 'programs:team': { ai: { version: 'sha256:' + 'a'.repeat(64) } } } });
  return { root, folder, make, tick: ms => { clock += ms; } };
}

test('a folder holds the definition and FunctAI\u2019s saved program; a broken file says what is wrong', t => {
  const { folder } = setup(t);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['functai.json', 'program.json']);
  assert.equal(d.readSource(folder).definition.name, 'team');
  fs.writeFileSync(path.join(folder, 'program.json'), '{ "name": "team", ');
  assert.match(d.readSource(folder).error, /not valid JSON/);
  fs.writeFileSync(path.join(folder, 'program.json'), JSON.stringify({ ...team(), inputs: [] }));
  assert.match(d.readSource(folder).error, /at least one input/);
  assert.match(d.readSource(path.join(folder, 'nope')).error, /missing/);
});

test('publishing copies the draft: editing it afterwards changes nothing callers get; rollback and offline', t => {
  const { folder, make, tick } = setup(t);
  const reg = make();
  reg.add({ name: 'team', module: 'programs', folder, project: 'work', by: 'u1' });
  assert.throws(() => reg.add({ name: 'team', module: 'programs', folder, by: 'u1' }), /already exists/);
  assert.equal(reg.liveDefinition('team'), null, 'nothing live before publishing');
  const v1 = 'sha256:' + '1'.repeat(64), v2 = 'sha256:' + '2'.repeat(64);
  reg.publish('team', { version: v1, by: 'u1' });
  // The draft changes: the live copy does not.
  d.writeSource(folder, d.normalizeDefinition({ ...team(), description: 'Something else.' }), {});
  assert.equal(reg.liveDefinition('team').definition.description, 'Which team should answer this customer message?');
  tick(1000);
  reg.publish('team', { version: v2, by: 'u1' });
  assert.equal(reg.liveDefinition('team').definition.description, 'Something else.');
  reg.rollback('team', v1, 'u1');
  assert.equal(reg.liveDefinition('team').version, v1);
  assert.throws(() => reg.rollback('team', 'sha256:' + '9'.repeat(64), 'u1'), /never published/);
  reg.unpublish('team');
  assert.equal(reg.liveDefinition('team'), null);
  // It all survives a restart.
  const again = make();
  assert.deepEqual(again.get('team').published.map(p => p.version), [v1, v2]);
  assert.equal(again.get('team').project, 'work');
});

test('keys: shown once, kept as a hash, one program each, revoked at once', t => {
  const { root, folder, make } = setup(t);
  const reg = make();
  reg.add({ name: 'team', module: 'programs', folder, by: 'u1' });
  const { secret, key } = reg.createKey('team', { label: 'git hook', by: 'u1' });
  assert.match(secret, /^chp_[A-Za-z0-9_-]{32}$/);
  assert.equal(key.prefix, secret.slice(0, 8));
  assert.ok(!fs.readFileSync(path.join(root, 'registry.json'), 'utf8').includes(secret), 'the secret is not stored');
  assert.equal(reg.keyFor(secret).program, 'team');
  assert.equal(reg.keyFor(secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(reg.keyFor('not a key'), null);
  assert.equal(make().keyFor(secret).key.label, 'git hook', 'after a restart too');
  reg.used('team', key.id);
  assert.equal(reg.get('team').keys[0].calls, 1);
  reg.revokeKey('team', key.id);
  assert.equal(reg.keyFor(secret), null);
  assert.ok(reg.get('team').keys[0].revoked);
});

test('a key may call so often and so many at once', () => {
  let now = 0;
  const lim = d.createLimiter({ perMinute: 3, atOnce: 2, now: () => now });
  const a = lim.take('k'), b = lim.take('k');
  assert.ok(a.ok && b.ok);
  assert.match(lim.take('k').why, /2 calls at once/);
  a.release(); a.release();
  assert.ok(lim.take('k').ok);
  const full = lim.take('k');
  assert.equal(full.ok, false);
  assert.match(full.why, /3 calls a minute/);
  assert.ok(lim.take('other').ok, 'each key its own');
  now = 61000;
  b.release();
  assert.ok(lim.take('k').ok, 'a minute later');
});

test('a caller is told what the program takes and gives, as JSON Schema', () => {
  const def = d.normalizeDefinition({ ...team(), inputs: [...team().inputs, { name: 'note', shape: { anyOf: [{ type: 'string' }, { type: 'null' }] } }] });
  assert.deepEqual(d.describe(def, { url: 'https://h/programs/team', version: 'sha256:x', n: 3 }), {
    name: 'team', description: 'Which team should answer this customer message?', url: 'https://h/programs/team', version: 'v3', version_id: 'sha256:x',
    input: { type: 'object', properties: { message: { type: 'string', description: 'what the customer wrote' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['message'] },
    output: { type: 'object', properties: { result: { enum: ['shipping', 'billing'], type: 'string' } }, required: ['result'] },
    answer: 'result',
  });
});
