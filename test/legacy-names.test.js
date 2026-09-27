'use strict';
// The product was called "aiconvo" until 2026-09-22. Everything written
// before then — session entries, message markers, project markers, theme
// files, the data folders in the home directory — carries that name and
// must keep working without anyone touching it. New writes use the new
// name only. These tests pin both halves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const conversationFlow = require('../conversation-flow.js');
const projectId = require('../projectid.js');
const themes = require('../themes.js');
const { parseUsageFile, PricingCatalog } = require('../usageanalytics.js');
const { migrateHome, PLACES } = require('../legacy-homes.js');

test('message markers: the old spelling reads as the same operation; new ones are written with the new name', () => {
  for (const name of ['aiconvo', 'chattering']) {
    assert.equal(conversationFlow.operation({ role: 'user', text: `3 models answered.\n\n<!-- ${name}:merge -->` }).kind, 'merge', name);
    assert.equal(conversationFlow.operation({ role: 'assistant', text: `both\n\n<!-- ${name}:both -->` }).kind, 'both', name);
    assert.equal(conversationFlow.operation({ role: 'user', text: `Continue.\n<!-- ${name}:regenerate -->` }).kind, 'regenerate', name);
    assert.deepEqual(conversationFlow.operation({ role: 'user', text: `x\n<!-- ${name}:operation {"kind":"merge","sources":[]} -->` }), { kind: 'merge', sources: [] }, name);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('<!-- chattering:merge -->') && !src.includes('<!-- aiconvo:merge -->\\n'), 'new merges carry the new marker');
});

test('reply-speed entries: both spellings are read from transcripts', () => {
  const speedLine = customType => ({ type: 'custom', customType, id: 's1', timestamp: '2026-01-01T00:00:05Z', data: { v: 1, samples: [{ entryId: 'r1', at: 1767225600000, provider: 'acme', model: 'fast-1', stopReason: 'stop', thinkingLevel: 'off', waitMs: 900, startMs: 400, text: { chars: 1200, timedChars: 1000, ms: 4000, chunks: 30 }, thinking: { chars: 0, timedChars: 0, ms: 0, chunks: 0 }, tool: { chars: 0, timedChars: 0, ms: 0, chunks: 0 }, usage: { output: 300, reasoning: 0 } }] } });
  return (async () => {
    for (const customType of ['aiconvo-speed', 'chattering-speed']) {
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-speed-')));
      const file = path.join(dir, 'one.jsonl');
      fs.writeFileSync(file, [
        { type: 'model_change', id: 'm', timestamp: '2026-01-01T00:00:00Z', provider: 'acme', modelId: 'fast-1' },
        { type: 'message', id: 'r1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', provider: 'acme', model: 'fast-1', usage: { input: 1, output: 300, cacheRead: 0, cacheWrite: 0 } } },
        speedLine(customType),
      ].map(JSON.stringify).join('\n'));
      const { speed } = await parseUsageFile(file, { source: 'pi' }, new PricingCatalog());
      assert.equal(speed.length, 1, customType + ' is read');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
});

test('project marker: the old folder is read when the new one is absent; writes go to the new folder only', () => {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-marker-')));
  fs.mkdirSync(path.join(cwd, '.aiconvo'));
  fs.writeFileSync(path.join(cwd, '.aiconvo', 'project.json'), JSON.stringify({ id: 'p_0123456789abcdef', name: 'old' }));
  assert.deepEqual(projectId.readMarker(cwd), { id: 'p_0123456789abcdef', name: 'old', createdAt: null });
  projectId.writeMarker(cwd, { id: 'p_0123456789abcdef', name: 'old' });
  assert.ok(fs.existsSync(path.join(cwd, '.chattering', 'project.json')), 'written under the new name');
  assert.equal(projectId.MARKER_REL, path.join('.chattering', 'project.json'));
  fs.writeFileSync(path.join(cwd, '.chattering', 'project.json'), JSON.stringify({ id: 'p_fedcba9876543210', name: 'new' }));
  assert.equal(projectId.readMarker(cwd).id, 'p_fedcba9876543210', 'the new folder wins when both exist');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('custom theme files: the old metadata block header still parses', () => {
  for (const header of ['aiconvo-theme', 'chattering-theme']) {
    const { metadata, error } = themes.parseMetadata(`/* ${header}\n * name: Paper\n * id: paper\n */\n:root{}`);
    assert.equal(error, null, header);
    assert.equal(metadata.name, 'Paper');
  }
});

test('home folders: moved once to the new name, never over an existing destination, idempotent', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-home-')));
  for (const [oldRel] of PLACES) { fs.mkdirSync(path.join(home, oldRel), { recursive: true }); fs.writeFileSync(path.join(home, oldRel, 'keep.txt'), oldRel); }
  const logs = [];
  const first = migrateHome(home, { log: m => logs.push(m) });
  assert.equal(first.moved.length, PLACES.length);
  assert.equal(first.skipped.length, 0);
  for (const [oldRel, newRel] of PLACES) {
    assert.ok(!fs.existsSync(path.join(home, oldRel)), oldRel + ' is gone');
    assert.equal(fs.readFileSync(path.join(home, newRel, 'keep.txt'), 'utf8'), oldRel, newRel + ' holds the data');
  }
  const second = migrateHome(home);
  assert.deepEqual(second, { moved: [], skipped: [] }, 'nothing left to do');
  // An old folder appearing next to an existing new one is left alone,
  // and the operator is told so (the data would otherwise go unnoticed).
  fs.mkdirSync(path.join(home, '.cache', 'aiconvo'));
  logs.length = 0;
  const third = migrateHome(home, { log: m => logs.push(m) });
  assert.equal(third.moved.length, 0);
  assert.equal(third.skipped[0].why, 'destination exists');
  assert.ok(fs.existsSync(path.join(home, '.cache', 'aiconvo')));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /NOT moved: .*\.cache[\\/]aiconvo .*merge/);
  fs.rmSync(home, { recursive: true, force: true });
});
