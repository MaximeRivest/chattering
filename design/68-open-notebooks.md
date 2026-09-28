# 68 — Notebooks that keep running while you are elsewhere

> Since 2026-09-28 (design/77) the list is **Open files**: any file can be
> kept (a pin, Alt+P, or editing it, besides running a cell), the list is
> the server's and the same on every device, and `open-files.js` replaces
> `notebook-tabs.js`. What follows about running notebooks still holds;
> where it says the list is this window's, or that opening a file lists
> nothing, read design/77.

## The ask (2026-09-26)

> could we add notebooks with opened/attached rat processes be in a list
> below the chat list on the left panel and have them run / do their work
> even if i navigate away? i navigate between notebook/md files and ai
> conversation and i have many opened 'tabs / threads'.

Before this, leaving a notebook destroyed its editor and its runner. The
kernel (on the server, through rat) finished the cell, but the result had
nowhere to land, and "Run all" stopped at the cell that was running.

## What it does

- **A notebook joins the list when a cell runs in it from this window**
  (Run, Run all, the cell's own ▶). Opening a Markdown file to read it lists
  nothing: the list is for notebooks with work attached, not for every file
  glanced at. Once listed it stays until its ✕ (as a conversation row does).
- **Leaving a listed notebook parks it.** Its editor, runner and shared text
  stay alive off screen. A running cell finishes and its output is written
  under the cell; Run all carries on to the next cell; the shared text
  carries each change to disk and to anyone else in the file.
- **Coming back** (the row, Files, a link, Back) re-attaches the same
  editor: same undo history, same live panel and input prompt, same scroll
  position.
- **The row** sits in the side column under the conversations, above
  "Other processes", shaped like a conversation row (design/59):
  - working: the three dots, `running a cell · 40s` or
    `running all · cell 3 of 12`;
  - waiting for input: the amber `?` (and a toast you can click);
  - finished while you were elsewhere: bold with the green dot, `✓ ran · 12s`,
    and a toast; a failure is a red `!` with the reason;
  - ■ stops (interrupts the kernel, drops Run all's queue; variables stay);
    ✕ closes the row and releases the editor. The file and the kernel are
    untouched.
- The list survives a reload (per device, in local storage). A row whose
  editor is not in this window says **not loaded**; opening it loads it.

## Limits, said plainly

- **The result is written by this window.** The kernel runs on the server and
  always finishes, but the runner that turns its output into the document
  lives in the page. Closing or reloading the window while a cell runs loses
  that cell's output (and the rest of Run all's queue); the page asks before
  unloading when anything runs. Other devices do not see the row: it is this
  window's list. Doing the writing on the server instead (runs that survive a
  closed laptop and show on every device) is the larger next step: the server
  would own run-all queues and write results into the shared text itself.
- **Memory.** Each parked notebook keeps its editor. Running ones are never
  let go; past six idle ones, the one left longest ago is released and its
  row goes "not loaded".
- **Visits with an agent at work.** A file with an ask-box agent editing it
  (ask-bubble.js) is closed on leaving, as before: that agent's settle and
  review are bound to the visit.

## Where it lives

- `notebook-tabs.js` — the list: entries, park/take, row markup, persistence,
  the unload guard.
- `app.html` — `parkDocument`, `resumeDocumentEditor`, `disposeDocSession`;
  document saves and the runner's hooks are bound to their document, so
  background work checks `st.closed`, never `docState !== st`.
- `filesmode.js` — the file workspace parks instead of closing, and resumes
  instead of mounting.
