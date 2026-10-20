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

*Since 2026-10-20 (design/103) a note is written with a pen **or typed**:
the button is ✎ Note on every device (and N), it opens as a page where a
pen has been used and as a typed note elsewhere, an empty page that gets a
key becomes a typed note, and a page takes typed text. New notes go to
`documents/notes/` (`~/notes/chattering/notes/`); the folders below are
where notes made before that stay.*

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
- `data-pen` on a stroke: which pen drew it (design/99; absent = the
  ballpoint), with `stroke`/`stroke-opacity` written for other viewers only;
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

**How the pen is made fast** (second version, same day; the first felt
slow and lost lines). It follows the work already done for pens on this
machine: the AINOTE 2 handwriting keyboard (`~/Projects/iflytek/
handwriting-ime`: `fastink/`, `research/ebc/README.md`, `CLAUDE.md` "The
EBC fast-ink layer") and the reMarkable inks (`remarkable_customization/
meridian/src/ink.rs`, `inkpen/`). Their finding: on e-ink the delay is the
panel's update, not the app. A browser canvas (tldraw, and the first
version of this page) takes the slowest path: compositor, full frame, slow
waveform. What made the keyboard's pen feel fast was a nib drawn straight
onto the panel's overlay.

1. **On the Android app, the app's nib draws the live line.** On a Rockchip
   e-ink panel (`/dev/ebc`, the AINOTE 2) it is the keyboard's C nib
   (`android/app/src/main/cpp/ebc_nib.c`, from `fastink_ebc.c`): one pen
   event with its history is one polyline, one small rectangle, one update
   on the fast overlay waveform, a radius per point for pressure. Every
   invariant from there is kept: query first (Y8, bounds), rebuild the clip
   on every pen-down (the window moves without telling), clear and submit
   before disabling, drop the overlay when the window loses focus, turn
   coordinates for rotation. Elsewhere (phones, the emulator) the app draws
   the line as a view with unbuffered input. The page gets the line when the
   pen lifts, paints it, says so (`strokeDrawn`); the app wipes its copy only
   once the pen has rested 450 ms, so nothing blinks while writing and the
   panel never shows two copies (the keyboard's "stroke shadow" lesson).
2. **Wet, then set** (meridian's ink.rs). While the pen moves, the line is
   the raw samples, latency first. On lift it settles once
   (`ink-format.js settle`): samples under 0.6 px apart dropped (a slow pen
   floods one spot), a follower that goes half way to each sample (kills
   digitiser jitter), pressure low-passed, then simplified. The file stores
   the settled line.
3. **The look** (meridian, inkpen): a Catmull-Rom curve through the stored
   points, a disc at each joint that turns and the tangent band between
   neighbours, filled once (no seams, any corner); width from pressure on a
   sine ease (mid pressures matter most); ends tapered over a short run-in;
   a tap is a dot a little wider than the line.
4. **The page in a browser.** `pointerrawupdate` where there is one (the
   web's unbuffered dispatch), coalesced samples otherwise; the live layer's
   canvas asks for low latency (`desynchronized`); the browser's predicted
   points fill the last frame on screens that are not e-ink. Finished lines
   are painted on a canvas per page, one fill each; the eraser repaints only
   around what it took; pages far from the screen give their canvas back and
   are painted again in 5 ms slices when they come near. The paper and any
   added layer stay SVG under the ink; the added layer is built from the
   parsed file with an allow-list (shapes, text, pictures with data: or
   relative addresses), so a note an agent wrote cannot run code here.

**Measured** (headless Chromium, main thread slowed 4×, a note of 3 pages ×
450 lines; the tablet itself was off): raster work for 10 new lines and a
scroll fell from 166 ms to 49 ms; main-thread time per line and per pen
event is the same as before (under 1 ms per event in both); opening the
note 0.97 s against 0.86 s (the first page is painted before it shows). On
the Android emulator: stylus lines go through the app's layer, reach the
file, and a finger scrolls without writing (`test/ink-android-emulator.test.js`,
opt-in).

**The bug that made the first version feel broken.** Maxime's first note
from the device held two strokes of one point each, 7 and 9 ms long. On a
touch screen the browser first gives the pen to the element under it; the
page taking the pen made that element report a lost capture, which bubbled
up and was read as the pen lifting. Every line ended after its first point.
Only the page's own capture counts now; a test reproduces the sequence.

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
5. **Typed text on the page**, and moving a selection: built (design/99 for
   the selection, design/103 for typed text, which has its own layer,
   `data-ink-layer="text"`, and merges as a set like the strokes).

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
- **Not validated on the e-ink tablet yet.** It was off both times. The C
  nib is the keyboard's, already proven there, with one change (a radius per
  point); the app around it is tested on the emulator, which has no e-ink
  overlay. It needs the next app release (0.3.7) and a session on the device.
- **`/dev/ebc` is an open door on that firmware, not a public API.** The
  earlier review advised using it for measurement only. The app uses it only
  where it opens and answers as the keyboard found it (Y8, bounds), and
  draws as a view everywhere else; if a firmware update closes it, the pen
  keeps working, slower.
- **The live line and the settled line differ slightly**: raw samples while
  writing, smoothed after. On e-ink the app's copy stays until the pen
  rests, so the change shows once per pause, not per line.
- **The page paints from a canvas**: zooming will need repainting at the new
  size (cheap: each line's shape is kept); a page far away is blank for a few
  milliseconds when it comes near on a slow device.
- **A finger never writes by default.** A phone without a pen turns on
  "Draw with a finger" once (remembered on that device).
