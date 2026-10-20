'use strict';
// ink-notes.js — where notes are made (design/98, design/103).
//
// A note is written with a pen (a page, `<stamp>.ink.svg`, ink-format.js)
// or with a keyboard (Markdown, `<stamp>.md`). Which one is the person's
// first mark: the note opens as the kind this device suits, and an empty
// note becomes the other kind the moment the other input is used (convert).
//
// A project's notes go to <project>/documents/notes/, beside the Markdown
// documents (documents/, design/30): one plain folder for every note, by
// pen or by keyboard, that a person, Git and every agent working in the
// project find without being told. A note made outside any project goes to
// the notes folder (~/notes/chattering/notes/), which survives cache wipes
// like the rest of the memory. Notes made before design/103 stay where they
// were made (documents/handwritten/, ~/notes/chattering/handwritten/), so
// every link to them still works.
//
// Names come from the person's clock (the page says its time zone), so the
// folder lists notes in the order they were taken: 2026-10-10-1405.ink.svg.
// The file is created exclusively: two devices in the same minute get -2,
// never one note over the other.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const InkFormat = require('./ink-format.js');

const NOTE_FOLDER = path.join('documents', 'notes');
const LEGACY_FOLDER = path.join('documents', 'handwritten');
const INK_FOLDER = NOTE_FOLDER; // the name older callers use
const LOOSE = 'notes', LOOSE_LEGACY = 'handwritten';
const INK_EDIT_MAX = 24 * 1024 * 1024; // a long notebook, still far from a problem to read
const TEXT_EXT = '.md';
const isInkPath = InkFormat.isInkPath;
const isTextPath = p => /\.md$/i.test(String(p || '')) && !isInkPath(p);
const STAMP = /^(\d{4}-\d\d-\d\d-\d{4})(?:-\d+)?\.(?:ink\.svg|md)$/i;

function folderFor(projectCwd) { return path.join(path.resolve(projectCwd), NOTE_FOLDER); }
function looseFolder(notesDir) { return path.join(notesDir, LOOSE); }
// The person's own notes under the notes folder: not the AI's distilled
// notes beside them (search and records must not read them as those).
function looseFolders(notesDir) { return [path.join(notesDir, LOOSE), path.join(notesDir, LOOSE_LEGACY)]; }
function isLooseNote(abs, notesDir) {
  return looseFolders(notesDir).some(dir => {
    dir += path.sep;
    return String(abs).startsWith(dir) && (isInkPath(abs) || isTextPath(abs)) && !String(abs).slice(dir.length).includes(path.sep);
  });
}
// A file in a notes folder, either kind: a project's or a loose one.
function isNotePath(abs, notesDir) {
  const p = String(abs || '');
  if (!(isInkPath(p) || isTextPath(p))) return false;
  const dir = path.dirname(p);
  if (notesDir && looseFolders(notesDir).includes(dir)) return true;
  return dir.endsWith(path.sep + NOTE_FOLDER) || dir.endsWith(path.sep + LEGACY_FOLDER);
}

// The person's local time: `when` (ms) seen with their offset from UTC in
// minutes (Date#getTimezoneOffset, positive west of Greenwich).
function localDate(when, tzOffset) {
  const at = Number.isFinite(Number(when)) && Number(when) > 0 ? Number(when) : Date.now();
  if (!Number.isFinite(Number(tzOffset))) return new Date(at);
  const shifted = new Date(at - Number(tzOffset) * 60000);
  // A Date whose getters read as the person's wall clock.
  return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(), shifted.getUTCMinutes());
}

function inkText({ when, title = '', paper }) {
  return InkFormat.serialize(InkFormat.empty({ title: String(title || '').slice(0, 200), paper, created: new Date(Number(when) || Date.now()).toISOString() }));
}
// The first free name for a stamp (2026-10-10-1405), created with `text`.
async function createNamed(folder, stem, ext, text) {
  await fsp.mkdir(folder, { recursive: true });
  for (let n = 1; n < 100; n++) {
    const abs = path.join(folder, stem + (n > 1 ? '-' + n : '') + ext);
    try {
      await fsp.writeFile(abs, text, { flag: 'wx' });
      return { path: abs, text };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('too many notes made in this minute');
}

// kind 'ink' (a page; the default, as before) or 'text' (Markdown, which
// holds `text`, usually nothing yet).
async function create({ folder, when, tzOffset, title = '', paper, kind = 'ink', text = '' }) {
  const stem = InkFormat.fileName(localDate(when, tzOffset)).replace(/\.ink\.svg$/i, '');
  if (kind === 'text') return createNamed(folder, stem, TEXT_EXT, String(text || ''));
  return createNamed(folder, stem, '.ink.svg', inkText({ when, title, paper }));
}

// Is this note still empty: nothing written, nothing typed? Only an empty
// note changes kind, so a conversion never drops anything.
function isEmptyNote(abs, text) {
  if (isInkPath(abs)) {
    try { return InkFormat.isBlankNote(InkFormat.parse(text)); } catch { return false; }
  }
  return !String(text).trim();
}

// An empty note becomes the other kind: the new file takes the same stamp
// (2026-10-10-1405.ink.svg → 2026-10-10-1405.md, or -2 when taken) in the
// same folder, then the empty one goes. Refused (status 409) once anything
// is in it, so a note another device just wrote in is never removed.
async function convert({ path: abs, to, text = '', paper, when, title = '' }) {
  abs = path.resolve(String(abs || ''));
  const from = isInkPath(abs) ? 'ink' : isTextPath(abs) ? 'text' : '';
  if (!from) throw Object.assign(new Error('not a note'), { status: 400 });
  if (to !== 'ink' && to !== 'text') throw Object.assign(new Error('a note is ink or text'), { status: 400 });
  if (to === from) return { path: abs, unchanged: true };
  let before;
  try { before = await fsp.readFile(abs, 'utf8'); }
  catch (e) { throw Object.assign(new Error(e.code === 'ENOENT' ? 'the note is gone' : e.message), { status: e.code === 'ENOENT' ? 404 : 400 }); }
  if (!isEmptyNote(abs, before)) throw Object.assign(new Error('the note has writing in it'), { status: 409 });
  const base = path.basename(abs);
  const stem = (base.match(STAMP) || [])[1] || base.replace(/\.(ink\.svg|md)$/i, '');
  // An ink note's own name (its <title>) goes with it.
  if (from === 'ink' && !title) { try { title = InkFormat.parse(before).title || ''; } catch {} }
  const made = to === 'text'
    ? await createNamed(path.dirname(abs), stem, TEXT_EXT, String(text || ''))
    : await createNamed(path.dirname(abs), stem, '.ink.svg', inkText({ when, title, paper }));
  // Read again just before it goes: something written meanwhile keeps it.
  const now = await fsp.readFile(abs, 'utf8').catch(() => null);
  if (now != null && isEmptyNote(abs, now)) await fsp.unlink(abs).catch(() => {});
  else if (now != null) return { ...made, kept: abs };
  return made;
}

module.exports = { NOTE_FOLDER, LEGACY_FOLDER, INK_FOLDER, INK_EDIT_MAX, isInkPath, isTextPath, folderFor, looseFolder, looseFolders, isLooseNote, isNotePath, localDate, create, convert, isEmptyNote };
