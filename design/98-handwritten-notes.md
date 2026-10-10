# 98 — Handwritten notes: a page to write on, kept in the project

## The ask (2026-10-10)

> I would like to have a very delightful way to take handwritten notes with
> my pen and the e-ink devices within a project and have them easily,
> automatically, well stored somewhere, and even turned into text so that
> they can be added to the project's intent and the to-dos. […] For now
> make sure that we have a space and a user flow to create notes and
> drawings […] but keep in mind, in the way you're architecting that, that
> we are able to pretty soon add help features and AI commands based on our
> drawings while we take the handwritten note. Ultimately a drawing canvas
> where I could get help with image generation, finishing my sketches, and
> bringing them back into the text in ways I can erase them.

Design/78 named the gap already: in the working cycle, step 6, "note things
for later", has no place. The pen was a way to *annotate* (the old ink over
a diff, removed with the file Gantt in 355d684); it was never a way to
*think*. This note gives the pen its own surface, and lays the format down
so the AI layers that come next attach to it without changing it.

## What a person does

1. **Start.** ✎ beside `+ new` in the side list (shown once this device has
   used a pen, and always on the e-ink tablet), `▾ → ✎ Handwritten note`
   anywhere, or `✎ Handwritten note` in a project's files. One tap, no name
   to type: the note opens on a blank page, in the project in scope.
2. **Write.** The pen writes, its width following its pressure. The finger
   scrolls (1:1, no fling on e-ink); a hand resting on the screen while the
   pen is near writes nothing. The mouse writes too. Tools: Pen, Eraser
   (touches a line, the whole line goes; the pen's eraser end works too),
   three widths, Undo/Redo. ⋯: paper (blank, lines, grid, dots), Draw with a
   finger (for a phone without a pen), Add a page, Download this page as a
   picture, the conversation beside, keep under Open files.
3. **Pages.** A4-shaped pages one under the other. Writing on the last page
   puts a fresh one below it, so there is always somewhere to go on.
4. **Nothing to save.** It saves itself a moment after the pen stops, on
   leaving, and when the tab hides. No connection: the note is kept on this
   device and sent when the connection comes back (and offered back, merged,
   the next time it opens here).
5. **Find it again.** It is a file: under Open files in the side list (✎),
   in recent files, in the project's `documents/handwritten/`, beside a
   conversation (☷). Tap the title to name it; the file keeps its dated name
   so links never break.

## Decisions

**A note is a file, `<name>.ink.svg`.** Not a database row, not a special
store. Files on disk are the truth here (design/78); a file gets Git, file
history, recent files, open files, sharing, the side panel and agents' tools
for free, and it outlives Chattering. SVG because every browser, file
manager, GitHub page and image tool shows it as what it is; a model can be
given it as a picture by any of them.
*Rejected:* InkML (the W3C ink format: exact, but nothing displays it);
a JSON file (nothing displays it, agents see numbers); Markdown with ink
blocks (couples the pen to the MRMD editor; a Markdown page can embed the
note instead, `![](handwritten/2026-10-10-1405.ink.svg)`, which already
renders).

**Inside the SVG** (`ink-format.js`, read and written by the page and the
server with the same code):

- one `<g data-ink-page>` per page, 1000 × 1414 units (A4's ratio) whatever
  the screen, so a note written on the tablet reads the same on the phone;
- per stroke a `<path>`: the centre line (absolute first point, relative
  steps, a tenth of a unit: about 0.02 mm), `data-p` one pressure digit per
  point, `data-t` start time (ms) and duration. Outside Chattering the path
  is drawn as a plain line in `currentColor`; inside, as a filled outline
  whose width follows the pressure;
- `<desc data-ink-text>` per page: the page as text, once something reads it
  (reserved now, see below);
- **anything else is kept verbatim**: a page's other elements go to its
  `data-ink-layer="extra"` group and come back out unchanged, as do unknown
  top-level elements. That is where later layers live.

Unchanged notes serialise byte-for-byte the same, so opening and leaving a
note never makes a commit-worthy change.

**Where notes go.** `<project>/documents/handwritten/`, beside the Markdown
documents (`documents/`, design/30): a plain folder people, Git and every
agent in the project find without being told. Without a project:
`~/notes/chattering/handwritten/`, durable like the memory. Names come from
the person's clock: `2026-10-10-1405.ink.svg`, created exclusively, so two
pens in the same minute make `-2`, never one note over the other.

**Two devices, one note.** Strokes are only added or erased, never moved,
so a note is a set and two versions merge exactly: keep what this side has,
add what the other side added since the common version, drop what the other
side erased. A stroke is known by its page, start time and end points, which
survive the file's rounding. Nothing doubles (the MRMD duplication of
design/collab taught that integrity is the first requirement).

**Rendering.** Finished strokes are SVG paths: sharp at any size, no page
repaint, erasing removes one element, resizing is free. The line being drawn
is on a canvas over the page (cheapest to add to); on pen-up it becomes a
path and the canvas is cleared in the same frame, so nothing blinks on
e-ink. Pages off screen are skipped by the browser (`content-visibility`).
The extra layer is built from the parsed tree with an allow-list (shapes,
text, pictures with data: or relative addresses): a note an agent wrote
cannot run code in Chattering.

**The Android app's pen overlay.** On the app, the native overlay
(InkOverlay.kt) draws the live line with less delay than the page can, and
hands each finished stroke to the page (`fileInkAcceptPacked`, now with
pressure and time). It used to take the pen over the whole screen (it
served only the old diff annotation); it now writes only inside the
rectangle the page gives it (`ChatteringInk.setRegion`), so the toolbar and
menus keep the pen as a pointer, and the page turns it off while its menu is
open. An app without `setRegion` is left alone: the page then draws by
itself. Not through the encrypted link either: from inside the relay's
frame the page cannot tell the app where the frame sits.

## What comes next, and where it plugs in

Each of these is a layer on the same file; none needs a format change.

1. **Read the writing.** A FunctAI program (design/74) `ink_read(page) →
   { text, todos, decisions, questions }` takes the page as a picture
   (`InkNotes.pageImage(i)` already renders one; the server can render the
   SVG the same way) and writes the text into the page's
   `<desc data-ink-text>`: the note becomes searchable and grep-able by
   agents with no other file. A Settings switch per kind of automatic call,
   as for titles (TODO.md §3). The local handwriting service of the e-ink
   keyboard (iflytek/handwriting-ime) is the fast alternative for plain
   text; a vision model is the one that reads diagrams and arrows.
2. **Into the project.** The read text feeds project memory like a
   conversation does (an evidence leaf per note page, with a path back to the
   page), so intent and to-dos can cite "handwritten, 10 Oct, page 2". A
   to-do written by hand shows in the project's to-dos with its page.
3. **Select and ask.** A lasso tool gives a selection: strokes (exact) and a
   picture of the region. AI commands (the `J` menu, ai-commands.js) get an
   `ink` surface: "turn into text", "make a diagram", "explain", "send to a
   conversation" (the picture attached to the composer, the note beside).
4. **The AI draws back.** What a model adds — a generated image, a cleaned
   diagram, typed text placed on the page, a finished sketch — goes in the
   page's extra layer as elements marked `data-by="ai"` (with the command and
   model), drawn in `--ink-ai`, never mixed with the pen's strokes: the
   eraser and undo treat each addition as one object, and "remove what the AI
   added" is one filter. The pen layer stays only what the hand wrote.
5. **Typed text on the page**, and moving a selection, both as extra-layer
   elements; the set merge above extends to them by id.

## Trade-offs, stated

- **Stroke eraser only.** Touching a line removes the whole line, as in
  most note apps. A partial eraser splits strokes and breaks the "strokes are
  never changed" property the merge relies on; it can come later as "erase
  = remove + add the remaining pieces".
- **Width follows pressure inside Chattering only.** Outside, the SVG shows
  each stroke at its nominal width. Storing outlines would double the file
  and lose the centre line that reading and merging need.
- **Coordinates rounded to a tenth of a unit, and lines simplified**
  (Douglas–Peucker, 0.3 units, pressure-aware) before saving: about half the
  points of the raw input, invisible at any zoom. A note stays small (a dense
  page is ~100 KB); the editor's size limit is raised for notes (24 MB) so a
  long notebook can never become unopenable.
- **No live co-writing.** Two devices writing at once merge at each save
  (seconds), not stroke by stroke. Enough for one person across devices; a
  shared live canvas would ride on the collaboration server later.
- **Not validated on the e-ink tablet yet.** The tablet was off when this
  was built. The page path is tested in Chromium with pen, mouse and touch
  events; the overlay changes compile but need the next app release (0.3.7)
  and a session on the device.
- **A finger never writes by default.** A phone without a pen turns on
  "Draw with a finger" once (remembered on that device).
