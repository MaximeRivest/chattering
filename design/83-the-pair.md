# 83 — The pair: a conversation and what it made, side by side

*2026-09-29. A study, then built the same day (below); the study follows as written.
Asked by Maxime after the ask box's "details" panel (design/80): "it feels
risky to create another conversation view … something responsive, almost
what we have on the phone, side by side and integrated with Markdown — and
the other way round, the Markdown in the artifact panel while we chat. Both,
because different people have different focus at different times. Study
how the artifacts work; we have to integrate all these pieces together."*

This is design/78's step 4 ("the pair, both ways"), made concrete against
the code as it is today.

## As built (2026-09-29)

Maxime: "go do it all at once, all the way, remove the in-betweens." The
decisions below were taken as recommended (P1–P5), in one change.

| Piece | Where |
|---|---|
| The tilt (talking / working), the conversation's width while working, the pill, the ways in (`openFile`, `openChange`, `withConversation`), mounting and letting go of the file | `pair.js`, `pair.css` |
| The panel's kinds `document` (the file view, placed in the panel) and `change` (one step's change); a text or Markdown artifact at its current version in the editor; ⇄ swap, full page, ← Made / Files; per-conversation memory of a file | `artifacts.js` |
| The file view's frame as one movable element (`liveFileFrame`), placed beside (`openLiveFileBeside`), moved full page (`fileWsToPage`), "☷ Conversation beside" in its head | `live-file.js` |
| A file placed beside survives a move between conversations' routes; files and changes clicked in the conversation open beside (Shift+click and the menu: full page); the change view renders into any host; the right Files list opens beside; Alt+\ in the help | `app.html` |
| The ask box: in a pair it sends to the conversation on screen; "details" / "conversation" bring the conversation beside the file | `ask-bubble.js` |
| Alt+P pins the file beside; voice commands know it is there | `open-files.js`, `voice-commands.js` |
| Removed: design/80's panel (`ask-panel.js`, `ask-panel.css`, its test) | — |
| Test: the whole journey in a browser | `test/pair.test.js` |

Differences from the study, and why:

- **The address does not carry the pair** (`&beside=` was proposed). A
  conversation remembers what was beside it (the artifact panel's
  per-conversation memory, extended to files), so Back, Forward, a reload
  and coming back to the conversation all reopen it. *Cost:* a link shared
  with someone else opens the conversation without the file beside it. The
  router was being changed by another session at the same moment; the
  memory needed no change to it.
- **Coming back to a conversation reopens what was beside it** every time,
  not only on the first visit of the page (the artifact panel did that only
  once per page load). Closing it with ✕ forgets it.
- **A new artifact never replaces a file being edited beside**: it is
  offered in a notice ("◧ New: … — open it beside") instead.
- **The panel's own "Ask"** (a mention of the thing in the conversation's
  message box) is hidden for a file, whose head has ✦ Ask (the change box);
  two "Ask" buttons with different meanings side by side confused.
- **History is a full-page view**: from a file beside, History moves the
  file full page first.
- **The narrow and phone behaviour**: over the conversation, ⇄ reads
  "☷ conversation" and steps the panel aside; a pill with the file's name
  (top right) brings it back; Android's back button steps it aside too.

## What exists (read in the code, 2026-09-29)

**The artifact panel** (`artifacts.js`, `artifacts.css`, design/67) is
already the "beside" surface of the app:

- One `<aside id="artifactPane">`, in the app's right column (grid column 3,
  `--right-w`), the slot it shares with the Files / Artifacts / Programs
  lists: one at a time. The conversation keeps 420px beside it; under that it
  lies over the conversation; on a phone it is a full sheet opened only on
  request. Resizable (width per device), **floating** (picture in picture,
  moved by its head, stays across pages), full screen, open in a tab,
  **Ask** (puts a reference into the conversation's own composer).
- It shows: files declared as artifacts, **at the version on the reading
  head's path** (checkpoints after every tool call), or the disk at the
  conversation's end, with a version picker and honest banners ("the files
  on disk are different now"); widgets and code previews (MCP Apps host on
  the preview origin); pictures (the lightbox's "beside" and "float").
- It follows the conversation: a new artifact opens itself (not on phones),
  the last one reopens when you come back to the conversation, the head
  moving moves the version. Leaving the conversation hides it, unless
  floating.
- **A Markdown artifact is read-only** there, drawn with the chat's own
  Markdown renderer — not the editor, not even the MRMD reader design/67
  promised. Code and text files: a plain `<pre>`.

**The file view** (`live-file.js`, `filesmode.js`, MRMD) is the real
editor: shared editing with agents and other screens, cells that run, the
ask box, review of AI changes, history. It **replaces** the page: opening a
file from a conversation (a change: `openToolCallFile`; a path:
`openPathInApp`) navigates away, with "← Conversation" to come back.

**One document at a time.** `fileWs` and `docState` are single; leaving the
file kind of page closes the workspace (`setRouteKind`). But the editor can
already **move without being rebuilt**: `resumeDocumentEditor` and
`fileWsResumeCode` put a parked editor's element into a new frame with its
undo history, cursor, shared text and running cells (the Open files list,
design/77). About fifteen places assume the file *is* the page
(`viewKind === 'file'` in app.html, open-files.js, voice-commands.js; two
`$('view')` lookups; the phone's height rule).

**The conversation view** assumes it is the page in about 120 places
(`#view`, `current`, `activeRel`). It already reads well at 420px (beside
an artifact). It must not be copied.

**Design/80's panel** (`ask-panel.js`) drew a second, simplified view of a
conversation beside a file. It works and is tested, but it is exactly the
copy this note rules out: every change to how conversations read would
have to be made twice, and it already lacks artifacts, widgets, delegation
cards, pictures, file links and answer groups.

## The shape

**The conversation is always the one real view, in the main column. The
thing beside it is always in the right column.** A file, a deck, a PDF, a
widget, a picture: all open in the one panel. "Both ways" is not two
layouts — it is the same two things with the width tilted:

| | main column | right column |
|---|---|---|
| **Talking** (focus on the conversation) | the conversation, wide | the page or artifact, ~45% |
| **Working** (focus on the page) | the conversation, narrow (420px, like the phone) | the page or artifact, wide |

- One control on the panel's head, **⇄**, tilts between the two (and a key).
  Dragging the edge still works; the two tilts are remembered per device.
- In "working", the conversation moves to the **right** of the page (the
  grid places the panel in column 2 and the conversation in column 3; the
  elements do not move, so nothing reloads), so the page stays where the eye
  was and the chat sits where Cursor, Google Docs and Copilot put it.
- **A page in the panel is the real editor** — the file workspace, moved
  into the panel, not a second editor: editable when it is the current
  version (the disk), read-only with "edit the current version" for older
  versions on the head's path. Shared editing, cells, the ask box, review of
  AI changes: all as in the full view, because it is the full view.
- Phone and e-ink: one side at a time, the panel a sheet, a toggle between
  them (as the artifact panel does today).

### Where things open

- **From a conversation**, a file link or a changed file opens **beside**
  it, not in its place; "full page" stays one click (and a modifier-click).
  A change opens as its diff beside, with "edit the file" to switch the
  panel to the editor.
- **An artifact card** ("Open"): as today; a Markdown or text artifact at
  its current version opens in the editor instead of the read-only page.
- **From a file** (full page): a new head button **"with its conversation"**
  opens the pair tilted to "working": the file keeps its place, the
  conversation it came from (or the one of its last ask) appears beside it.
  The ask box's "details" does the same — which is what design/80 wanted,
  without a second view.
- **The ask box in a paired page** sends to the conversation on screen by
  default; its run line points at the conversation beside it instead of
  opening anything.

### Addresses

The conversation's address carries the panel (`…&beside=<path or
artifact>&tilt=work`), so Back, Forward, a reload and a shared link reopen
the same pair. The artifact panel's per-conversation memory stays for
"reopen what was open last time here".

## How it is built (the safe way)

**One document slot that moves**, not an editor in two places. The file
workspace gets a *placement*: the page (as now) or the panel. Opening a
file beside moves the one editor into the panel frame (the Open files
mechanism); "full page" moves it back. Opening a *different* file full
page while one is beside parks the beside one (it stays in Open files if
kept) and the panel shows the new one's conversation pair or closes — one
document on screen at a time, as today, so the ~80 single-slot places do
not change. *Trade-off:* two different files at once (one full, one
beside) are not possible; design/78's "editor in more than one place" can
come later if it is missed.

Changes, by risk:

1. Routing: `setRouteKind` keeps the workspace when it is placed in the
   panel; the ~15 `viewKind === 'file'` checks ask "is a file workspace on
   screen" instead; the file frame is sized by its host, not the page.
2. The panel: a `document` kind whose body is the file frame; the tilt;
   the column swap in "working"; the head's controls merge (the file head
   keeps its own actions inside the panel, folded by width — the container
   query of design/80 already does this).
3. Entry points: conversation file links, artifact cards, the file head's
   "with its conversation", the ask box's "details".
4. Remove `ask-panel.js` and its test; keep what design/80 added to the box
   (plain by default, the agent's first words, `askSubmit`, the head that
   folds by its own width).

Each step is testable alone; the existing tests of the editor, open files,
artifacts, floating corners and the phone shell cover most regressions.

## Limits, said plainly

- **Behaviour change:** a file link in a conversation stops leaving the
  conversation. Some people like the full page for reading code; "full
  page" and a modifier-click keep it one step away, and the choice could be
  a setting if missed.
- **One document at a time** stays (see above).
- **Two live surfaces on one screen:** keys typed in the page must not
  trigger the conversation's shortcuts and the reverse; the editor already
  keeps its keys, the composer too, but each global shortcut needs checking.
- **Narrow conversation:** at 420px some conversation controls wrap; its
  head may need the same "fold by its own width" as the file head.
- **Another session is changing the conversation and navigation code** as
  this is written; the routing step should land after it.

## Decisions this needs (Maxime's)

- **P1** — The pair as designed: the conversation stays the one view in the
  main column, the page or artifact beside it, tilted either way. And
  design/80's separate panel removed. *Recommend yes.*
- **P2** — In "working", the conversation on the **right** of the page
  (nothing jumps; where people expect chat), or fixed on the left?
  *Recommend right.*
- **P3** — File links in a conversation open **beside** by default, full
  page one click away? *Recommend yes.*
- **P4** — Until the pair ships, keep design/80's panel (the ask box's
  "details" keeps working) or remove it now ("details" goes back to the
  full page)? *Recommend keep it until step 3 replaces it, then delete it
  in the same change,* so "details" never regresses and nothing new is
  built on it.
- **P5** — One document at a time, moved between page and panel, now; an
  editor in several places only if missed? *Recommend yes.*
