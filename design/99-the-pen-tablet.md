# 99 — The pen tablet: Chattering as the place to think with AI on e-ink

## The ask (2026-10-10)

> I want to embark on a new chapter in Chattering: get the Chattering
> Android app on the iFlytek to be the absolute best "everything" app to
> interact and work with AI on e-paper Android, from a pen. It has to weave
> back and be useful from the other apps; it has to be a delightful place to
> read longer writing by AI or found (in a conversation or an artifact), but
> also a place to take notes in any of the projects, for them to serve as
> prompts and context; a place to test the results of the AI too. For this we
> need an extremely good and smooth ink pen experience.

## What this chapter is

The laptop is where agents are *run*. The tablet becomes where work is
*thought about*: read what the agents made, write back by hand, keep notes
that become prompts, try what was built, and do it all with a pen, at a
desk or on a couch, away from the keyboard. Same computers, same
conversations, same projects (the tablet stays a portal into lambda, as the
phone is); what changes is the instrument.

Five jobs, each already partly in Chattering, none yet good on the tablet:

| Job | The person | Exists | Missing on the tablet |
|---|---|---|---|
| **Write** | writes with the pen and it shows *now*, looks like ink, never loses a line | notes (design/98), the e-ink nib (`ebc_nib.c`) | the nib was never used through the encrypted link (fixed, below); validated latency; lasso, select, move |
| **Prompt by hand** | writes a question or a correction and sends it; an agent gets the writing and its text | handwriting keyboard (iflytek/handwriting-ime, system-wide); images in the composer | ink straight in the composer; a note page or a selection sent to a conversation; reading the writing (ink_read) |
| **Read** | reads a long answer, a report, an artifact, a paper, comfortably for half an hour | e-ink theme (design/11), citations (design/97), artifacts, PDF viewer | a reading view made for paper: typography, page step, position kept across devices, a reading list, margin notes in ink |
| **Try** | opens what the agent built (a page, an app, a notebook) and tests it, then says what is wrong | artifacts, notebooks, review changes | artifact full screen on e-ink, ink over any artifact or file sent back as feedback (the old diff-ink idea, design/98 §3) |
| **Weave** | from any app: send a text, a link, a picture, a PDF to Chattering, or select text and ask; and send Chattering's results out | pairing links open the app; the keyboard works in every app | Android share target, "Ask Chattering" on selected text, sharing an answer or note out, a "new note" shortcut |

## The pen comes first

Every job above is done with the pen, so the pen sets the ceiling. The
target, from the e-ink devices that feel good (reMarkable, Boox, the
AINOTE's own note app): **the line appears under the nib in about 20–40 ms,
is never lost, never doubled, never drawn by the palm, and looks like ink,
not like a line from a drawing program.**

What the pen log (`~/notes/chattering/pen-log.md`) showed on 10 Oct, with
the current app installed:

- `path: page`, `fastNib: false` on every line. The note page refused the
  app's fast layer whenever it ran inside a frame, and through the encrypted
  link Chattering always does (it is a frame of the app's shell). So the
  e-ink nib built for this app was never used on the tablet: every line went
  through the web page and the panel's full refresh. **Fixed 2026-10-10**
  (`ink-editor.js frameOffset`, test `ink-app-frame-browser.test.js`, which
  fails on the old page). No app update needed: the page is the server's.
- `rateHz` ~43: the web page got 43 pen points a second. The digitiser
  reports far more; the app's layer reads all of them (`getHistorical*`).
  With the fix, the page no longer sees the pen while it writes.
- The emulator test never covered the encrypted link (it connects by
  address), which is why it passed. Any pen test from now on runs both ways.

What remains for the pen, in order:

1. **Validate on the AINOTE**: write half a page; the log must say
   `appPen: true`, `path: app`, `fastNib: true`. Then measure, not feel:
   the app logs, per line, the time from the pen event (`eventTime`) to the
   nib's submit, and the page logs how long until the finished line is
   painted. Budget: input → nib submit under 8 ms; the rest is the panel's
   waveform, which only the device can tell.
2. **The handover** (nib copy → page copy) must be invisible: no flash, no
   double line, no visible shift between the raw and the settled line. If
   the shift shows, settle less while on e-ink.
3. **Ghosting**: a page with many partial updates gets grey residue. A
   full refresh on demand (two-finger tap) and automatically after N lines
   or on page change, as the keyboard does.
4. ~~A palette of pens~~ (done, below). **Lasso** (select strokes, move, delete, "ask about this", "turn into
   text"): the same gesture becomes the bridge to every AI command (§ Prompt).
5. **The pen outside notes**: the pen taps and scrolls like a finger
   everywhere else (it does: the app only takes it inside a note's region),
   and writing *on* a conversation, an answer or an artifact (§ Read, Try)
   uses the same layer with a transparent page.

### Pens and the toolbar (2026-10-11)

Asked after the first session with the fast pen: "a palette of pens", menus
that are not hidden, "more like reMarkable or good painting apps", "sketch
very delightfully". Done (app 0.3.7 for the live line; the page for the rest):

- **Seven pens** (`ink-format.js PENS`): ballpoint (the old pen, unchanged),
  fineliner (even), pencil (grain, darker when pressed), brush (strong
  pressure, long taper), calligraphy (a flat nib at 45°: wide across it, a
  hairline along it), marker, highlighter (a chisel, multiplied under the
  writing so black stays black). Five sizes each. Greys on every screen
  (ink, dark grey, light grey, white); blue, red, green and highlighter
  colours only where the screen has colour.
- **In the file** a stroke carries `data-pen` (absent: ballpoint, so every
  older note reads the same) and, for other viewers, what a plain line can
  show (a highlighter is a pale yellow band). A pen this version does not
  know is kept and drawn as a ballpoint.
- **Toolbar**: three pens at hand, each shown as a stroke of itself; a tap
  takes one, a tap on the one in hand opens the palette (every pen as a
  sample drawn by the page's own shape, sizes, colours, a preview). 1 2 3 on
  a keyboard. Eraser, tapped again: "Clear this page" (undoable). The ⋯
  became a labelled **Page** button. A pop-up closes at the first touch
  outside it, and that touch draws nothing; while one is open the app's
  layer lets the pen go to the page.
- **The live line on e-ink** follows the pen's width curve and direction
  (`InkOverlay.penFactor`, the same curves) and its tone: the overlay shows
  black or nothing, so a grey is an even 4×4 screen of black dots, a pencil a
  fixed random grain, a highlighter a light screen (`ebc_nib.c tone_on`).
  White ink has no live line (the overlay cannot show white).
- A line keeps the pen it was started with (a test caught a pen switched in
  the 40 ms the page waits for a broken line to rejoin, which changed it).
- The picture of a page (download, and what a model will read) is drawn
  with the real pens, not as centre lines.
- **Pressure** is learned as the middle of the last 15 lines, not a running
  average: one hard brush stroke (or injected input at full force, which
  moved it from 0.11 to 0.29 during testing) no longer thins the next ten.

Fixed on the way: thick lines showed pale hairlines across them (bands left
a wedge open at bends where the joint's disc was skipped; the bend allowed
now shrinks with the radius), and the outline used for SVG samples drew its
discs the other way round from its bands, which cancelled into holes.
Seen in Chromium's software raster only, and not on the AINOTE: tiny
horizontal ticks inside very thick loops, where a shape overlaps itself many
times (GPU raster, and the tablet's screenshot, show none).

### The lasso (2026-10-11)

Select (L) circles lines with the pen; a line is chosen when at least half
its points are inside the loop. The selection floats in a layer of its own
(its lines drawn there, the page repainted without them, a dashed frame)
with three buttons: **✦ Ask**, **Delete**, **Done**. A pen or a finger in the
frame drags it (a palm does not); outside it, the pen draws a new loop and a
finger scrolls. A move is saved as the old lines out and new ones in, one
undo step, so the set merge between devices still holds; lines stay on
their page.

**Ask** is the first step of "prompt by hand": the circled lines become a
picture (as they look, on white), and go to the composer of the
conversation beside the note when there is one, else to a new conversation
in the note's project, with "About this part of my handwritten note
(documents/handwritten/…, page n): " and the cursor after it. Nothing is
sent until the person writes or says the question and sends. While the
lasso is the tool, the page has the pen (the app's fast layer is off): a
dashed loop needs no e-ink speed, and the selection's buttons need taps.

### Fast lasso, holes, copy and paste (2026-10-11, app 0.3.8)

Asked: the lasso felt slow ("make it fast ink on top"), copy and paste, and
menus that could not be tapped when the side list was open: its ⋯ menu
hangs over the note, and the pen drew a line there instead.

- **Holes.** The app's fast layer took every pen landing in the writing
  area's rectangle, whatever the page showed there. The page now tells the
  app what covers the area (`setHoles`), and a pen landing in a hole is the
  page's. Covers are found from what changes (a MutationObserver on the page
  and the shell around it): a changed element over the area, not part of it,
  that the browser says is on top at a few points of the overlap. A grid of
  hit tests over the whole area was tried first and measured on the AINOTE:
  230–330 ms per update. The change-driven check: 6–20 ms. An app without
  `setHoles` (0.3.7) gives the page the pen while anything covers the area.
  Checked on the tablet: with the side list's ⋯ menu over the note, a pen
  tap on the menu draws nothing.
- **The lasso through the app**: the loop is drawn on the e-ink overlay,
  dashed (`ebc_nib.c TONE_DASH`, dashes counted along the whole line), and
  comes back to the page marked `lasso` (the app now names the pen of each
  line). The selection's frame and buttons are holes, so dragging and the
  buttons are the page's.
- **Copy** (selection bar, Ctrl+C; Ctrl+X cuts) keeps the lines on this
  device, so they paste into another note too, and offers a picture to the
  system clipboard where the browser allows. **Paste**: a tap in Select with
  something copied offers "Paste here"; Ctrl+V pastes mid-screen. Pasted
  lines are the selection, to drag into place; one undo step.
- **Delete** moved to the end of the selection's bar, apart from Done, and
  says "Deleted n lines. Tap here to undo." (as does Clear this page). On
  the first day, a page of Maxime's first note lost 55 of its 56 lines in one
  step a minute after he used Ask on it; the file history had it and it was
  restored. Nothing in the records says whether it was a Delete he meant;
  a test of Ask then back to the note loses nothing.

### Toolbar, dotted lasso, finger taps (2026-10-11, app 0.3.9)

- **The toolbar spilled over the note** on the tablet only: the rule that
  pads the app's bar under a phone's clock through the encrypted link
  (`html[data-anywhere-inset] body header`) matched every header, the
  note's too, and gave it a fixed height; the tools' wrapped second row hung
  over the page, where the upper half of a button took the tap and the
  lower half drew. The rule is now `body > header`, a note's header can
  never be given a height (`height: auto !important`), a narrow header puts
  the tools on their own row, and they keep clear of the floating ▤ button
  when they reach it. The app is also told about the header and floating
  elements from the start, not only after a change.
- **The lasso is dotted** while it is drawn (`TONE_DOT`: a dot every 15
  panel pixels; the page's own lasso draws dots too): dashes read as ink.
- **Two fingers tap: undo; three: redo.** All fingers down and up within
  400 ms, none moving more than 20 px, no hand-sized contact, no pen
  touching meanwhile (a pen hovering in the tapping hand is fine). The app
  watches when its layer has the note (it may hold fingers back from the
  page right after the pen) and calls `fileInkGesture`; the page watches
  only when that layer is off, so a tap never counts twice.

Not yet: reading the handwriting into text (the next step: "Ask" should
send the words too, and a note should be searchable), resizing a
selection, a partial eraser, a full refresh against
ghosting, tilt and speed (the AINOTE reports no tilt; speed would need the
point times the file does not keep).

## Order of work, and why

Each step is useful alone, and each is validated on the tablet before the next.

1. **Pen foundation** (above). Without it nothing else is pleasant.
2. **Weave in** (small, high leverage, all Android-standard): the app as a
   share target (`ACTION_SEND` text/links/pictures/PDF → new conversation, a
   project note, or the reading list), `ACTION_PROCESS_TEXT` ("Ask
   Chattering" in every app's selection menu, listing the same AI actions as
   the desktop's frog, design/93–94), sharing out an answer, a note page or
   an artifact, and a launcher shortcut "New note". Needs app 0.3.7+.
3. **Prompt by hand**: a ✎ in the composer opens a writing strip; on send the
   model gets the writing as a picture *and* its text (the handwriting
   service at :8077 for plain text; a vision model for diagrams). A note's
   page or a lasso selection can be sent to a conversation the same way.
   Then `ink_read` (design/98 §1) fills each page's text, so notes are
   searchable and feed project memory as evidence.
4. **Read**: a reading view for answers, Markdown documents and artifacts,
   tuned for paper (measure and line height for 227 ppi, no animation, a
   page step that keeps a line of overlap, design/11), position kept per
   document across devices, a reading list fed by "share to Chattering",
   and margin notes in ink that stay with the text and can be sent back as
   feedback ("about this paragraph: …").
5. **Try**: artifacts and notebooks full screen on e-ink, ink over them as a
   transparent layer, and "send my marks" to the conversation that made
   them, with the marked picture and the region's text.

## Rules for this chapter

- **Validated on the device or not done.** The emulator has no e-ink overlay
  and no real pen; it proves wiring only. Each step ends with the person's
  own session on the AINOTE and the pen log or a screenshot to show it.
- **Both connections.** Everything is tested by address *and* through the
  encrypted link: the tablet uses the link.
- **One core, 4 GB.** The tablet's WebView is the slow part; work that can
  be native (the live line, share intents, refresh control) is native, the
  rest stays the page so every device gets it.
- **The pen's layer is only what the hand wrote** (design/98): AI additions,
  recognised text and selections live beside it, never mixed into it.
- **A note is a file** in the project (`documents/handwritten/`); a margin
  note on a document is a file beside that document, not a hidden record.
- **Nothing private leaves without the person**: sharing *in* creates a
  draft, never sends to a model by itself; automatic reading of handwriting
  is a Settings switch, like titles.

## Trade-offs, stated

- The tablet stays a portal into lambda. Writing works offline (notes are
  kept on the device and merged later, design/98), but asking a model needs
  the computer. A local model on the tablet is out of scope.
- `/dev/ebc` is not a public API (design/98). If a firmware update closes it
  the pen keeps working, slower (the app's view layer), and the log says so.
- The share target and "Ask Chattering" need an app update the person
  installs by hand (no store, design/85); the app already tells the page its
  version and the page offers the download.
- The chapter competes with the rest of TODO.md; it is §6 ("Polish the phone
  and the iFlytek") made concrete and given the pen as its centre.
