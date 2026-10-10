'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ink = require('../ink-notes.js');
const F = require('../ink-format.js');

test('a project note goes to documents/handwritten, named by the person\'s clock, never over another', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-notes-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const folder = ink.folderFor(project);
  assert.equal(folder, path.join(project, 'documents', 'handwritten'));
  // 18:05 UTC seen from UTC-4 (offset +240) is 14:05 on the person's clock.
  const when = Date.UTC(2026, 9, 10, 18, 5, 30);
  const a = await ink.create({ folder, when, tzOffset: 240, title: 'Kitchen' });
  const b = await ink.create({ folder, when, tzOffset: 240 });
  assert.equal(path.basename(a.path), '2026-10-10-1405.ink.svg');
  assert.equal(path.basename(b.path), '2026-10-10-1405-2.ink.svg');
  const note = F.parse(fs.readFileSync(a.path, 'utf8'));
  assert.equal(note.title, 'Kitchen');
  assert.equal(note.pages.length, 1);
  assert.equal(note.created, new Date(when).toISOString());
});

test('loose notes live directly in the notes folder, and only those count as notes documents', () => {
  const notes = '/home/x/notes/chattering';
  assert.equal(ink.looseFolder(notes), path.join(notes, 'handwritten'));
  assert.equal(ink.isLooseNote(path.join(notes, 'handwritten', 'a.ink.svg'), notes), true);
  assert.equal(ink.isLooseNote(path.join(notes, 'handwritten', 'deep', 'a.ink.svg'), notes), false);
  assert.equal(ink.isLooseNote(path.join(notes, 'handwritten', 'a.svg'), notes), false);
  assert.equal(ink.isLooseNote(path.join(notes, 'a.ink.svg'), notes), false);
});
