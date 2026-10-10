'use strict';
// ink-notes.js — where handwritten notes are made (design/98).
//
// A project's notes go to <project>/documents/handwritten/, beside the
// Markdown documents (documents/, design/30): a plain folder that a person,
// Git and every agent working in the project find without being told. A note
// made outside any project goes to the notes folder (~/notes/chattering/
// handwritten/), which survives cache wipes like the rest of the memory.
//
// Names come from the person's clock (the page says its time zone), so the
// folder lists notes in the order they were taken: 2026-10-10-1405.ink.svg.
// The file is created exclusively: two pens on two devices in the same
// minute get -2, never one note over the other.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const InkFormat = require('./ink-format.js');

const INK_FOLDER = path.join('documents', 'handwritten');
const INK_EDIT_MAX = 24 * 1024 * 1024; // a long notebook, still far from a problem to read
const isInkPath = InkFormat.isInkPath;

function folderFor(projectCwd) { return path.join(path.resolve(projectCwd), INK_FOLDER); }
function looseFolder(notesDir) { return path.join(notesDir, 'handwritten'); }
function isLooseNote(abs, notesDir) {
  const dir = looseFolder(notesDir) + path.sep;
  return String(abs).startsWith(dir) && isInkPath(abs) && !String(abs).slice(dir.length).includes(path.sep);
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

async function create({ folder, when, tzOffset, title = '', paper }) {
  await fsp.mkdir(folder, { recursive: true });
  const date = localDate(when, tzOffset);
  const text = InkFormat.serialize(InkFormat.empty({ title: String(title || '').slice(0, 200), paper, created: new Date(Number(when) || Date.now()).toISOString() }));
  for (let n = 1; n < 100; n++) {
    const abs = path.join(folder, InkFormat.fileName(date, n));
    try {
      await fsp.writeFile(abs, text, { flag: 'wx' });
      return { path: abs, text };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('too many notes made in this minute');
}

module.exports = { INK_FOLDER, INK_EDIT_MAX, isInkPath, folderFor, looseFolder, isLooseNote, localDate, create };
