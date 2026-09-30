# 88 — Files changed, read in the conversation

*2026-09-30. Asked by Maxime: "When I'm reading a conversation, I would like
a much nicer diff view in the conversation, almost as an artifact but not
quite… and a very nice way to read the file if it has been created… not
open by default… I don't want to be taken away. We have tools that create
files and change files, and we need a robust way of detecting them, because
they can be done in very different ways: even shell commands create files
and edit them."*

## What a person sees

**Under each box of steps**, a list of the files those steps changed, one
row per file: its kind (**A** new, **M** changed, **D** deleted, **W**
written, when whether it existed before is not on record), its name, its
folder, and lines added and removed (`+12 −3`; a new file `+48`; a picture
says *picture*). The row says only what needs a word: *found* (the step did
not name the file; comparing before and after shows it changed), *from the
command* (read from a shell command, not observed), *also edited
elsewhere* (another conversation changed it at the same time), *3 steps*
(the row is the change of all of them together). Files in a temporary
folder fold under *N temporary files*. Changes made while other,
unaccounted work ran in the same folder fold under *N files also changed
while this ran*; they are not claimed. A box that changed nothing shows
nothing: the old "N files touched · Review changes" line under every box,
changes or not, is gone.

**A row opens the change right there**, under it, in the conversation:

- a changed file: one column at reading width, three lines around each
  change, the rest folded (`⋯ 1,704 lines above`, `⋯ 42 unchanged lines`,
  each opening on a press), long lines wrapped, never scrolled sideways;
  syntax colours; inside a changed line, the changed words marked;
- a new file: the file to read, with line numbers and colours, its opening
  and *show all N lines*; a Markdown file as a page (*source* one press
  away), a long one showing its opening and *read the whole page*;
- a deleted file: what it had, on request (*what it was*);
- a picture: the picture (before and after, when both were saved);
- a file changed since: *changed since*, and *since then* compares the
  version the steps left with the file now.

Each card has **open** (the file itself beside the conversation, design/83;
Shift: full page) and **review** (the review of these steps, at this file,
design/36). Nothing opens by itself. What is open stays open when the
conversation redraws (a reply arriving, a branch switch).

**Inside the box**, each step says what it changed: an edit step's file
name carries its `+3 −1`; a shell step lists the files it changed as small
chips. Pressing one opens that one step's change under its line. The list
under the box is the whole box's change, file by file; the step is the
detail.

The keyboard's file walk (`.`, `j`/`k`, Enter) reaches the rows and chips;
Enter opens and closes them. Voice lists them with the box's files.
Right-click keeps the file menu (the change beside, the file full page,
keep open…).

## Where the list comes from (step-changes.js)

Evidence, strongest first:

1. **Observed.** A Chattering-run Pi agent saves the project before and
   after every step that could change a file (checkpoint-extension.js,
   design/36), shell commands included. The two snapshots are Git trees;
   **all the steps of a conversation are compared by one Git process**
   (`git diff-tree --stdin`, `CheckpointStore.diffTrees`), which gives each
   step's changed files with both versions and line counts. 85 steps: 64 ms;
   441 steps: 0.7 s the first time, then kept in memory (a finished step
   cannot change). Whatever wrote the file (an edit tool, `sed -i`, a
   heredoc, a Python script, `git checkout`), the change is seen.
2. **Saved by name.** A shell command's named outputs (a redirect, `tee`,
   `cp`'s destination, `sed -i`, even `writeFileSync("x")` in a `node -e`)
   are now saved before and after the command, like an edit tool's file.
   So a file Git ignores (`out/`, logs) or one outside the project is
   observed too. A named output that is a folder, a binary file or
   protected is simply not saved, without a warning ("soft" targets).
3. **Recorded.** No snapshots (Claude Code, Pi in a terminal, conversations
   from before design/36): the edit tool's own arguments. The card rebuilds
   the whole file around the edit: it undoes the later recorded edits from
   today's file, then this one, so the diff has real line numbers and its
   surroundings; failing that, from an earlier recorded write going
   forward; failing both, the edits alone, labelled so.
4. **From the command.** A shell command's named output that nothing
   observed, still on disk as a file: listed as *from the command*, its
   card the file as it is now. A name that is a folder now, or gone
   (`rm -rf /tmp/cw`), is not listed; it used to be, as a dead link.

**What the step did, not what ran beside it.** A snapshot pair covers the
whole folder, and other work runs there: another conversation, a sub-agent,
a person, a build. The rules:

- a file the step named is the step's;
- an edit or write tool is never credited with any other file;
- a file a shell (or unknown) step did not name is the step's only if no
  other known work changed it in that time: other steps' own snapshot pairs
  in the same folder overlapping in time (their changes are subtracted),
  and other conversations' recorded edits in the project (subtracted too);
- if other work that has no complete pair ran at the same time (a step still
  running, one that never ended), the file goes under *also changed while
  this ran*, unclaimed;
- a file the step named that another overlapping step also changed is
  marked *also edited elsewhere*.

The checkpoint store's own `overlapping` flag was not used: on a real
conversation it was set on 156 of 175 steps (any unfinished step in the
last 24 hours counts), so it could not tell anything apart. Overlap is
worked out from the steps' times instead, with a new index on
(folder, time).

**A box's change, file by file**, is the change from the first step that
changed the file to the last: counted between those two snapshots (by Git,
or directly for files saved by name). A file changed and changed back in one
box is not listed.

## Decisions, and what they cost

- **In place, not beside.** The earlier click opened one step's change in
  the side panel, halving the conversation, as two mostly empty columns.
  Auditing is reading down a conversation; the card opens where the eye
  already is. *Cost:* a long diff lengthens the conversation while open (the
  first 400 changed rows are drawn, then *show more*). The change beside is
  still in the right-click menu, and *open* puts the file itself beside.
- **One column, wrapped.** At the conversation's width a unified diff reads;
  side by side would halve each line again. Long lines wrap instead of
  scrolling sideways, which hides text on touch screens.
- **Changed words marked without touching the colours**: the CSS Custom
  Highlight API draws ranges over the highlighted code. Where it is missing
  the lines are still marked. Word marks are skipped on mostly rewritten
  lines, where they would be noise.
- **Colours for what is shown only**: each visible stretch is highlighted on
  its own, starting afresh (exact except inside a comment or string that
  began above it). A change on line 18,000 of a 19,000-line file costs the
  same as one on line 10.
- **Drawn at once where possible.** Rows the transcript already knows (edit
  and write tools) are drawn with the page, then filled in; boxes of shell
  steps appear when the list arrives (one request for the whole
  conversation, cached per box on the page and on the server). A box whose
  steps still run is asked about again every 4 s.
- **"Review changes" per box moved into the card** (and the turn's
  *Review whole turn* shows only where the turn changed files).
- **Nothing saved.** The list and the cards are worked out on request, from
  the snapshots and the transcript. The review (design/36) still saves when
  a person reviews.

## Limits, said plainly

- **Files a script writes without naming them, outside the project or
  ignored by Git**, are not seen: nothing saves them. Inside the project and
  not ignored, they are.
- **A person typing in another editor** (outside Chattering) while a long
  shell step runs: the change can be credited to the step, since nothing
  records that person's work. Chattering's own editor saves are recorded,
  but not yet subtracted.
- **Claude Code and terminal Pi conversations** have no snapshots: what
  their shell commands changed is read from the commands.
- **Binary files outside artifact folders** are seen appearing, changing
  size class or leaving, not their contents; a picture shows as it is now.
- **The side panel's "change" view** (right-click → View this change beside)
  still uses the older per-call view, which knows edit tools only.
- **A card carries whole files**: both versions (and the file now, when it
  changed since), up to 2 MB each, so folds open and *since then* compares
  without asking again. Opening a change to a very large file on a slow
  connection takes a moment; the list itself stays small.
- **While a reply streams**, the live box above the composer has no list
  yet; it appears when the reply's steps are saved into the conversation.

## Where it lives

- `step-changes.js` — the engine: steps from the conversation file,
  snapshot pairs compared in one Git process, targets, overlap and
  subtraction, recorded fallbacks, the box's net change, a file's two
  versions and the file now.
- `checkpoint-store.js` — `diffTrees`, `snapshotHeads`, `boundariesBetween`,
  `targetVersion`; the (root, started) index; soft targets never warn.
- `checkpoint-extension.js` — `stepTargets`: a shell command's named outputs
  saved before and after it.
- `server.js` — `stepChanges()`; `POST /api/conversation/changes`,
  `GET /api/conversation/change`, `GET /api/conversation/change-blob`
  (policy.js: the conversation must be visible to the person, and the file).
- `step-changes-ui.js`, `step-changes.css` — the list, the chips, the card
  (diff, reading view, page, pictures), what stays open across redraws.
- `conversation-reader.js` — the list under each box; the turn's review;
  `app.html` — an edit step's count, a step's chips, a press opens in place.
- Tests: `test/step-changes.test.js` (observed, unnamed outputs,
  subtraction of other conversations' steps and edits, unfinished work left
  unclaimed, net change and change-and-back, outputs saved by name and
  folders never warning, from the command, rebuilt recorded edits, scratch,
  paths with spaces and binaries), `test/step-changes-app.test.js` (the
  journey in a browser: rows, the diff with its folds and word marks, a
  Markdown page and its source, a picture, a rebuilt recorded edit, a
  step's chip and card, what stays open after a redraw, review from a card).
