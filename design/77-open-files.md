# 77 — Open files: any file kept in the side list, on every device

## The ask (2026-09-28)

> i would like to be able to pin / keep files opened as 'tabs' in the
> notebooks section even if i don't run code cell, and even if not md files.

Until now (design/68) the side list's "Notebooks" section held only Markdown
notebooks, and only after a cell ran in them from this window; the list was
this browser's alone. A file you were reading and editing, a script, a PDF
you kept going back to, had no place there.

## What a person sees

- The section under the conversations is **Open files**. Each row: a glyph
  for the kind of file (▤ document or notebook, ‹› code or text, ◩ image,
  ▷ video, ▯ PDF), the file's full name (two kept files of one name also
  show their folder), the project, and for a notebook what its cells are
  doing, as before. ✕ closes the row, with Undo in the toast. Newest kept on
  top; a row never jumps while it is used.
- **A file joins the list when you mean it, not when you look at it:**
  - you pin it: the pin by its name in the file's header (outlined; filled
    once kept), `Alt+P` (in the text too, and inside the PDF reader), the ⋯
    menu, the pin on a Files browser row (on hover, always on touch screens),
    or "Keep open in the side list" in a file link's menu in a conversation;
  - you run a cell in it (as before);
  - you edit it yourself: typing, pasting, deleting, accepting an AI
    suggestion. A change that is not yours (an agent's write arriving, a
    collaborator's typing, a cell's output, a reload) keeps nothing.

  Opening a file to read it adds nothing: most files are opened from a
  conversation to check them, and listing each would bury the few you work
  in. The first time a file is kept without a pin, a toast says why, once
  per device.
- **The list is the same on the laptop, the phone and the tablet.** Keeping
  or closing on one shows on the others at once.
- **Coming back to a kept file finds it as you left it** in this window:
  - a notebook or Markdown document: the same editor (undo history, cursor,
    scroll, a running cell still running, run all carrying on — design/68);
  - a code or text file: the same editor too (undo history, unsaved text,
    cursor, scroll, the HTML preview if it was showing). If the disk changed
    meanwhile, a clean editor takes the new text and says so; one with
    unsaved edits keeps them and offers a reload;
  - a PDF or a video reopens (quick to load) at the page or time it was
    left. This holds for every PDF and video, kept or not, as a text file's
    cursor already did.

## Decisions, and what they cost

- **Pin, run and edit — not "every file opened".** Chosen over listing every
  opened file (it floods: reviewing one agent turn opens many files) and
  over a VS Code "preview" row that the next opened file replaces (a row
  that changes under you, a third state to learn, poor on e-ink). The cost:
  a file only read and never pinned is not kept; Back and Files find it.
- **"Your edit" is precise, and conservative.** The editor bundle now tells
  its listeners whether a change was a person's (mrmd-document 0.25.0,
  `onChange({userEdit})`: a CodeMirror user event, not `output.*`). An edit
  made by a command that forgot to tag itself reads as not yours: at worst a
  file you edited is not kept automatically, never the reverse. Undo inside
  a shared file is the shared text's own undo and does not count by itself.
- **The server owns the list** (`/api/open-files`, `open-files-store.js`,
  `~/notes/chattering/open-files.json`), one per install, like the
  conversation list: the household's. Members read and write it; a guest
  (or a person the household walls off) keeps their own list in their
  browser, and never sees the household's. Each path is checked against
  what the person may see; one they may not is refused and named.
- **Order of changes.** Every change bumps a revision (it follows the clock
  and survives a restart); a browser drops a list older than one it has
  (an event arriving after the answer to a later change, a fetch that was
  under way). Only what differs from the server's list is sent, so letting
  a file go and keeping it again before the batch leaves sends nothing.
  Between devices, the change that reaches the server last wins: a device
  offline with a queued "keep" can, when it reconnects, keep a file another
  device closed meanwhile. Clocks on phones cannot be trusted enough to do
  better; the Undo and the ✕ are one tap either way.
- **Kept warm, within a budget.** Parked editors cost memory: past six idle
  ones in a window, the one left longest ago is released (a running notebook
  never is). Its row stays; opening it loads the file again (a code file's
  unsaved text comes back as the usual draft banner). A parked shared file
  stays joined to the shared text, so the people in it see you there, as
  with a parked notebook (design/68).
- **What stays per window.** A notebook's live run (running, waiting for
  input, run all's progress) is this window's: the runner that writes the
  result lives in the page. Its last result ("✓ ran · 3s") is remembered per
  device. Another device's row shows the file, not that run.
- **Not kept warm:** a visit that reviews an old version (a review or
  History), and a file an agent asked from its ask box is editing (that
  visit's settle and review are bound to it) — as for notebooks.
- **Migration.** The old per-browser notebook list joins the shared list
  once, in its own order; its last runs become this device's.

## Where it lives

- `open-files.js` — the list (server copy, changes, revisions, a guest's
  own list), the window's parked editors and runs, the rows, the pins,
  Alt+P. Replaces `notebook-tabs.js`.
- `open-files-store.js` — the server's list: keep, close, restore, revision.
- `server.js` — `/api/open-files` (GET, POST {keep, close, restore}), the
  `open-files` event; `policy.js` — members only, filtered per path.
- `filesmode.js` — `fileWsParkCode`, `fileWsResumeCode`,
  `fileWsDisposeParked`; `live-file.js` — `openLiveFile` reuses a parked
  workspace; the name-and-pin in the header (`liveFileNameHtml`).
- `app.html` — notebook parking (design/68), the rows' section, the file
  link menu's "Keep open", `userEdit` from the document editor.
- `file-viewers.js`, `pdf-viewer-config.js` — the page or time a PDF or a
  video was left.
- Tests: `test/open-files-app.test.js` (the whole journey, two devices, a
  guest, migration), `test/open-files-store.test.js`, and
  `test/change-origin.test.js` in mrmd-editor.
