'use strict';
// A test home whose person already answered the first-run question about
// background AI (design/32 §2), with everything off, and has had the welcome
// (design/75): tests make no model calls, the question's modal dialog would
// make the rest of the page inert (focus and typing silently do nothing),
// and home is the timeline. Tests about the first minutes leave the home fresh.
const fs = require('node:fs');
const path = require('node:path');

function answerFirstRun(home) {
  const { SETTINGS_VERSION } = require('../../settings.js');
  const file = path.join(home, '.config', 'chattering', 'settings.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ settingsVersion: SETTINGS_VERSION, ...current,
    backgroundAi: current.backgroundAi || { decidedAt: '2026-09-26T00:00:00Z', names: false, memory: false },
    welcome: current.welcome || { doneAt: '2026-09-26T00:00:00Z' } }));
}

module.exports = { answerFirstRun };
