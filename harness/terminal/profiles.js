'use strict';
// What Chattering knows about each agent's terminal program, as data. The
// code reads any program with generic rules (reader.js); a profile adds
// only what that program does differently: how to start or resume it, the
// marks it draws, the keys it reads. A new agent, or a changed screen after
// an update, is an entry here, never a branch in the code.
//
// Every field is plain JSON (patterns are strings), so a profile can be
// checked, diffed and, later, overridden without a release.
//
//   program      which installed program runs it (the server resolves the
//                binary: claudeBin(), Pi's cli.js, codexBin(), agentBin())
//   box          whether Chattering's own box can also continue it (Pi,
//                Codex); false: only its own program can (Claude Code,
//                Antigravity, Muse Code)
//   resume       arguments to continue a conversation. Placeholders:
//                {sessionId} the conversation's id, {sessionPath} its file
//   start        arguments to begin a new one with an id chosen beforehand
//                ({sessionId}); null when the program cannot be told
//   newSession   how the new conversation's file is found:
//                'known-id'  the program names its file after {sessionId}
//                'detect'    the program picks; the file is found once it
//                            appears (sessions.js, harness/live-terminal.js)
//   idPattern    the shape of an id the program accepts ('uuid' | 'uuidv7')
//   screen       the reader's rules:
//     prompts    marks that start the input box's first line
//     bullets    marks that start an answer or a step in the conversation
//     result     the mark of a step's result line
//     markers    marks of the selected option in a question or a list
//     glyphless  an input box may have no prompt mark (a framed region)
//     working    patterns of a line that says the program is working
//     frameWorking  pattern of a label inside a frame line saying the same
//     titleWorking  pattern of the terminal's window title while it works
//   keys.stop    the key that stops a reply (a key as the page describes
//                it; host.js encodes it). Line breaks inside a message are
//                pasted, which every line editor reads as text.

const WORKING_LINES = [
  'esc to interrupt',                         // Claude Code, Codex
  '^[✻✶✳✢✽·*∗⋆◐◓◑◒]\\s+\\S+…',                // a star spinner and a word: "✻ Thinking…"
  '^\\s*[\\u2800-\\u28ff]\\s+\\S',            // a braille spinner and a word: "⠦ Working"
];
const FRAME_WORKING = '[\\u2800-\\u28ff]|^(?:[✻✶✳✢✽·*∗⋆◐◓◑◒]\\s+)?\\S+…|\\b(working|thinking)\\b';
// Claude Code's window title: "◐ <name>" turning while it works (also
// while it writes its answer, when its status line is gone), "✳ <name>"
// when it is idle. Not generic: Codex turns a spinner in its title even
// when idle (recorded 2026-10-01).
const CLAUDE_TITLE_WORKING = '^[◐◓◑◒]';
// Muse Code turns a braille spinner before the folder's name in its title
// while it works ("⠦ muse2"), only then (recorded 2026-10-14, 1.4.6).
const MUSE_TITLE_WORKING = '^[\\u2800-\\u28ff]';

const GENERIC_SCREEN = {
  prompts: ['❯', '>', '›', '$'],
  bullets: [],
  result: null,
  markers: ['❯', '›', '>'],
  glyphless: true,
  working: WORKING_LINES,
  frameWorking: FRAME_WORKING,
  titleWorking: null,
};

const PROFILES = {
  generic: {
    id: 'generic', name: 'Terminal program', program: null,
    resume: null, start: null, newSession: null, idPattern: null,
    screen: GENERIC_SCREEN,
    keys: { stop: { key: 'Escape' } },
  },
  claude: {
    id: 'claude', name: 'Claude Code', program: 'claude', box: false,
    resume: ['--resume', '{sessionId}'],
    start: ['--session-id', '{sessionId}'],
    newSession: 'known-id', idPattern: 'uuid',
    // Its bullet changed from ⏺ to ● between 2.1.285 and 2.1.286: both.
    screen: { ...GENERIC_SCREEN, prompts: ['❯', '>'], bullets: ['⏺', '●'], result: '⎿', glyphless: false, titleWorking: CLAUDE_TITLE_WORKING },
    keys: { stop: { key: 'Escape' } },
  },
  pi: {
    id: 'pi', name: 'Pi', program: 'pi', box: true,
    resume: ['--session', '{sessionPath}'],
    // "Use exact project session ID, creating it if missing" (pi --help).
    start: ['--session-id', '{sessionId}'],
    newSession: 'known-id', idPattern: 'uuidv7',
    // An input box with no prompt mark (Pi pads its editor), "→" on the
    // selected row ("›" or ">" in a few of its lists), "⠦ Working" in its
    // box's frame line.
    screen: { ...GENERIC_SCREEN, markers: ['→', ...GENERIC_SCREEN.markers] },
    keys: { stop: { key: 'Escape' } },
  },
  codex: {
    id: 'codex', name: 'Codex', program: 'codex', box: true,
    resume: ['resume', '{sessionId}'],
    // Codex cannot be given an id for a new conversation: it picks one,
    // and its file appears under ~/.codex/sessions when the first message
    // is written.
    start: [],
    newSession: 'detect', idPattern: 'uuid',
    // A "›" line holding the cursor, no frame; "›" or ">" on a selected row.
    screen: GENERIC_SCREEN,
    keys: { stop: { key: 'Escape' } },
  },
  // Antigravity CLI (Google), 1.3.4, recorded 2026-10-14. "> " opens its
  // box between two frame lines; "> " marks the selected row of its
  // questions and of its / menu (read as a choice); "⣽  Generating..." and
  // "esc to cancel" while it works; ● a step, ○ its thinking.
  agy: {
    id: 'agy', name: 'Antigravity', program: 'agy', box: false,
    resume: ['--conversation', '{sessionId}'],
    // It picks a new conversation's id, and writes its file
    // (conversations/<id>.db) with the first message.
    start: [],
    newSession: 'detect', idPattern: 'uuid',
    screen: { ...GENERIC_SCREEN, prompts: ['>'], bullets: ['●', '○'], result: '⎿', glyphless: false },
    keys: { stop: { key: 'Escape' } },
  },
  // Muse Code (Meta), 1.4.6, recorded 2026-10-14. "❯ " opens its box
  // between two frame lines, its / menu inside that frame (the selected row
  // in another colour); "◇ Thinking (2s · esc to interrupt)" while it
  // works; ◆ an answer.
  muse: {
    id: 'muse', name: 'Muse Code', program: 'muse', box: false,
    resume: ['resume', '{sessionId}'],
    // It picks a new conversation's id and makes its folder as it starts
    // (sessions/YYYY/MM/DD/<id>/), recording its own process id there.
    start: [],
    newSession: 'detect', idPattern: 'uuidv7',
    // A paste under ~1000 characters is shown whole in its box (longer ones
    // fold: "[Pasted Content 2269 chars]"): a box may be that tall.
    screen: { ...GENERIC_SCREEN, prompts: ['❯'], bullets: ['◆', '◇'], glyphless: false, titleWorking: MUSE_TITLE_WORKING, maxBox: 40,
      // Its empty box shows a hint in a theme's grey, the cursor before it.
      hintAtCaret: true },
    keys: { stop: { key: 'Escape' } },
  },
};

const compiled = new WeakMap();
// The screen rules with their patterns compiled (once per profile).
function screenRules(profile) {
  const screen = (profile && profile.screen) || profile || GENERIC_SCREEN;
  let c = compiled.get(screen);
  if (!c) {
    c = { ...GENERIC_SCREEN, ...screen };
    c.workingRe = (c.working || []).map(p => new RegExp(p, 'i'));
    c.frameWorkingRe = new RegExp(c.frameWorking || FRAME_WORKING, 'i');
    c.titleWorkingRe = c.titleWorking ? new RegExp(c.titleWorking) : null;
    c.name = (profile && profile.id) || 'generic';
    compiled.set(screen, c);
  }
  return c;
}

function profileFor(id) { return PROFILES[id] || PROFILES.generic; }

// A profile's arguments with its placeholders filled. An argument whose
// value is missing is an error, not an empty string handed to a program.
function fill(args, values) {
  return (args || []).map(a => a.replace(/\{(\w+)\}/g, (_, k) => {
    if (values[k] == null || values[k] === '') throw new Error('missing ' + k + ' for this program');
    return String(values[k]);
  }));
}

module.exports = { PROFILES, GENERIC_SCREEN, profileFor, screenRules, fill };
