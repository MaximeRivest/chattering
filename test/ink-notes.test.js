'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ink = require('../ink-notes.js');
const F = require('../ink-format.js');

test('a project note goes to documents/notes, named by the person\'s clock, never over another', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-notes-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const folder = ink.folderFor(project);
  assert.equal(folder, path.join(project, 'documents', 'notes'));
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
  // A typed note: Markdown, the same stamp, empty until the person types.
  const c = await ink.create({ folder, when, tzOffset: 240, kind: 'text' });
  assert.equal(path.basename(c.path), '2026-10-10-1405.md');
  assert.equal(fs.readFileSync(c.path, 'utf8'), '');
});

test('an empty note changes kind, keeping its stamp; a note with anything in it never does', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-notes-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const folder = ink.folderFor(project);
  const when = Date.UTC(2026, 9, 20, 12, 30);
  const page = await ink.create({ folder, when, tzOffset: 0, title: 'Tuesday' });
  const typed = await ink.convert({ path: page.path, to: 'text' });
  assert.equal(path.basename(typed.path), '2026-10-20-1230.md');
  assert.equal(fs.existsSync(page.path), false, 'the empty page went');
  // Back to a page: the same stamp again (the page's name was free again).
  const back = await ink.convert({ path: typed.path, to: 'ink', when });
  assert.equal(path.basename(back.path), '2026-10-20-1230.ink.svg');
  assert.equal(fs.existsSync(typed.path), false);
  // Written in: refused, and nothing is touched.
  const n = F.parse(fs.readFileSync(back.path, 'utf8'));
  n.pages[0].strokes.push({ pts: [10, 10, 0.5, 20, 20, 0.5], w: 2, t0: 1, dur: 1, color: '' });
  fs.writeFileSync(back.path, F.serialize(n));
  await assert.rejects(ink.convert({ path: back.path, to: 'text' }), e => e.status === 409);
  assert.equal(fs.existsSync(back.path), true);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['2026-10-20-1230.ink.svg']);
  const text = await ink.create({ folder, when, tzOffset: 0, kind: 'text' });
  fs.writeFileSync(text.path, 'a word');
  await assert.rejects(ink.convert({ path: text.path, to: 'ink' }), e => e.status === 409);
  // A page with only typed text on it has something in it too.
  const p2 = await ink.create({ folder, when: when + 60000, tzOffset: 0 });
  const n2 = F.parse(fs.readFileSync(p2.path, 'utf8'));
  n2.pages[0].texts.push({ id: 't1', x: 60, y: 93, w: 400, size: 22, lh: 44, text: 'hi', lines: [{ s: 'hi', soft: false }] });
  fs.writeFileSync(p2.path, F.serialize(n2));
  await assert.rejects(ink.convert({ path: p2.path, to: 'text' }), e => e.status === 409);
  await assert.rejects(ink.convert({ path: path.join(project, 'README.txt'), to: 'ink' }), e => e.status === 400);
});

test('loose notes live directly in the notes folder (new and old), and only those count as notes documents', () => {
  const notes = '/home/x/notes/chattering';
  assert.equal(ink.looseFolder(notes), path.join(notes, 'notes'));
  for (const dir of ['notes', 'handwritten']) {
    assert.equal(ink.isLooseNote(path.join(notes, dir, 'a.ink.svg'), notes), true);
    assert.equal(ink.isLooseNote(path.join(notes, dir, 'a.md'), notes), true);
    assert.equal(ink.isLooseNote(path.join(notes, dir, 'deep', 'a.ink.svg'), notes), false);
    assert.equal(ink.isLooseNote(path.join(notes, dir, 'a.svg'), notes), false);
  }
  assert.equal(ink.isLooseNote(path.join(notes, 'a.ink.svg'), notes), false);
  assert.equal(ink.isNotePath('/p/documents/notes/2026-10-20-1230.md', notes), true);
  assert.equal(ink.isNotePath('/p/documents/handwritten/2026-10-10-1405.ink.svg', notes), true);
  assert.equal(ink.isNotePath('/p/documents/plan.md', notes), false);
  assert.equal(ink.isNotePath(path.join(notes, 'notes', '2026-10-20-1230.md'), notes), true);
  assert.equal(ink.isNotePath(path.join(notes, '2026-10-20-distilled.md'), notes), false);
});
