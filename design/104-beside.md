# 104 — Beside: keep what you are using in view, next to your work

*2026-10-22. A study, then built the same day (below); the study follows as
written. Maxime: "brilliant, do it all and do it most excellently." D1–D5
taken as recommended.*

## As built (2026-10-22)

| Piece | Where |
|---|---|
| The desk: tabs, which shows, pinned or following, each tab's ‹ back, where a thing opens, the + menu, a tab's menu, Alt+B / Alt+[ / Alt+], the corner square, kept per device (`chattering.beside.v1`) | `beside.js`, `beside.css` |
| The panel draws the tab shown; new kinds `file` (a PDF, a picture, a video: read, no editor), `folder` (the files browser), `lists` (Made, Files, Artifacts, Programs); a file whose editor is in the middle shows a copy to read | `artifacts.js` |
| One reader for PDFs and videos, full page and beside (the same remembered page or time) | `file-viewers.js` (`pdfReaderFrame`, `mountFileReader`) |
| The files browser lives in the middle, beside, or both: its elements are found in its own frame (`fb$`), ids prefixed `bs-` beside; a click opens where it was made, Shift+click the other place, a middle click a new tab; ◨ Beside in its head | `files-browser.js`, `files-browser.css` |
| ◨ Beside on a file page (and ⋯, the media heads, a note's menu): the editor moves as it is, the middle goes back | `live-file.js` (`fileWsToBeside`), `ink-editor.js` |
| A file kept warm while its tab waits (Open files' parked editors, same budget) | `open-files.js` (`hold`) |
| The pair follows the middle: a file beside a project page has no conversation; the narrow screen's button names what is in the middle | `pair.js` |
| The route keeps a file placed beside through any move; the old right column is a hidden parking place for the lists; folder links and "Open in a new tab beside"; help | `app.html` |
| What voice commands are told about the screen includes Beside's tabs | `voice-commands.js` |
| Test: the whole journey in a browser | `test/beside.test.js` |

What the build added to the study, and why:

- **A folder follows its project, not one conversation.** The screenshot's
  case is a project's folder used across that project's page, its files and
  its conversations; following one conversation made it vanish at the next
  click. Anything else unpinned follows the place it was opened in.
- **A folder or a list is never replaced from the middle.** Opened from the
  middle, a file goes to the place's unpinned *reading* tab (what it showed
  stays one ‹ away) or a new one; a folder or a list always keeps its own
  tab. Inside a folder or a list, a click navigates that tab, ‹ comes back.
- **One file is edited at a time** (the file workspace is one slot in about
  80 places, design/83 P5). A PDF, a picture or a video beside needs no
  editor, so the common case (read a paper, write in the middle) has no
  limit. A text file beside while another is edited in the middle shows the
  file as it is on disk, to read, saying so, with **Edit it here**: the
  middle steps back to where it came from and the editor comes beside.
  *Cost:* two text files cannot both be edited side by side.
- **Pin = beside everywhere, and kept in Open files** for a file (D2). The
  link is one way: unpinning does not let the file go from Open files (the
  side list's ✕ does), and keeping a file (editing it) does not pin it
  beside (that would make a note follow you because you typed in it). In
  Beside, Alt+P is the tab's pin and the file head's own keep pin is hidden,
  so there is one pin to understand.
- **Things that open by themselves** (an artifact an agent just made) take
  the screen only from an unpinned artifact of the conversation on screen;
  otherwise a notice offers them. Nothing steals a pinned tab, a file being
  edited, a change, a folder or a list.
- **A floating window** (picture in picture, design/67) floats Beside's tab
  shown; it stays over every page; closing it closes the window, and what
  the page had docked beside waits for the next move instead of popping up.
- **The corner square (◨)** is Beside's switch: shown or put away (Alt+B),
  with the number of tabs waiting. With nothing on the desk here, it opens
  the lists, as the old Files button did.
- **The old right column's lists** are a pinned tab; a browser that had them
  open finds that tab at first start.
- **Phones** keep design/58's bottom bar: Files is a destination; a file
  tapped there opens as the page and the sheet closes, as before. On every
  narrow screen, after the middle moves, the middle comes first and Beside
  waits behind its pill, which says how many tabs wait ("▦ work +2").
- **Limits kept small:** 40 tabs on the desk, 6 unpinned per place, 20
  steps of ‹ per tab. A widget's or a picture's HTML is not kept over a
  reload (its conversation shows it again).

Not done, on purpose or for later:

- Dragging tabs to reorder them.
- Two tabs side by side on a very wide screen (the study's "later, if missed").
- The top-bar layout has no corner square; Alt+B and the phone bar open Beside.
- The warm-editor budget (6) is not measured on the e-ink tablet.
- The folder in a project's summary page has no Shift+click to Beside; ◨ on
  the folder's own head does it.

Tests: `test/beside.test.js` (new); `pair`, `side-panel`, `voice-app`,
`files-ops-browser` and the surfaces specimens follow the new behaviour.
Failing before this change and unchanged by it: `surfaces` (a 6px radius in
app.html, #soundTapToHear), `conversation-app` (a file watcher version),
`file-viewers-browser` (PDF reload on tablet), and several unrelated server
tests; `phone-shell` and `artifacts-live` are flaky under load.

---


## The ask

> I would like to be able to pin / see on the right, next to the
> conversation / project, the file system / PDF views etc. (I guess I want
> some form of split screen / tab / windows.) What is the best ultimate
> design? Understand my deepest intent and propose a solution for that.

The screenshot that came with it: the bigspin project's file browser
(`…/litreview/originals/pdf`, PDFs an agent had just changed), opened from
the conversation "Multiscale Website Behavior Prediction". The browser takes
the middle column, about a third of the screen's width; the rest is empty.
The conversation is gone from the screen. Opening one of those PDFs will
replace the browser too.

## The intent under the ask

Not "windows". Windows are the tool he reached for. What he wants is:

1. **Nothing I am using disappears because I opened something else.**
   Today every place is one full screen: conversation → files → PDF, each
   replacing the last, and the way back is Back. Each replacement costs the
   thread of thought.
2. **Think with the agent while looking at the material.** In bigspin the
   conversation is the thinking partner and the PDFs, figures and folders
   are what is being thought about. Both belong on screen together, the way
   a person reads a paper with their notes open.
3. **A few things stay put for a whole stretch of work.** A reference PDF,
   the project's folder, what the agent made: pinned, there when he comes
   back from triaging another conversation.
4. **The screen works for him.** Half of a wide screen sits empty while he
   flips between full screens.

He has asked for parts of this before, each time from a different corner:

- 2026-09-26: "when we open images sometimes we want to keep reading about
  it … they can be put to the side … any artifact picture in picture".
- 2026-09-28 (design/77): files kept open "as tabs".
- 2026-09-29: "clicking details should not … take me away to the
  conversation, we should have a side panel"; then design/83, the pair:
  "both ways, because different people have different focus at different
  times".
- 2026-10-04: choose which conversation sits beside a notebook.
- 2026-10-08 (design/96): keep things around "to get back to later" without
  clutter.

And the lasting rules from the project memory that bound the answer: not a
full IDE; reuse the real views, never a second simplified copy (design/80
was removed for exactly that); calm, no focus stealing; usable on phone and
e-ink; quiet on weak devices.

## What exists, and where it stops

Most of the machinery is already built:

- **The artifact panel** (`artifacts.js`, design/67): the right column;
  shows files, PDFs, pictures, video, HTML pages and widgets; resizable,
  full screen, floating picture in picture.
- **The pair** (`pair.js`, design/83): a file in the *real* editor moved
  into that panel beside the conversation; ⇄ swap (Alt+\) makes either side
  the wide one; on narrow screens one side at a time with a pill.
- **Open files** (`open-files.js`, design/77): pinned files, synced on every
  device, with up to six editors kept warm (undo, cursor, scroll, running
  cells).

Where it stops — each of these is something the screenshot runs into:

| Limit today | Effect |
|---|---|
| The panel belongs to the conversation: leaving the conversation hides it (only a floating picture survives, and a file being edited cannot float) | Nothing stays put across conversations, the project page or home |
| One thing beside, never two | A PDF beside means the folder is gone, and the reverse |
| The folder browser (`files-browser.js`) is a full-screen place only (`viewKind === 'files-browser'`) | Browsing files throws the conversation off the screen — the screenshot |
| The right column is shared by three things, one at a time: the Files/Made/Artifacts/Programs lists, the artifact panel, the pair | Three ways to "show something on the right", each closing the others |
| From a project page or a folder, nothing can be put beside | The pair only exists while a conversation is the page |

## The shape

### Two places, not free tiling

The screen has **the main place** (the middle, as now) and **Beside** (the
right column). Never more panes than that; no dragging windows into grids.

*Why not free tiling or real windows:* every extra pane is layout a person
has to manage, and it is the first step to the IDE this product is not.
Reading with a reference open is a two-pane activity; iPad's Split View,
Arc's split and Google Docs' side panel all settle on two for that reason.
Two panes also stay within what a phone, an e-ink tablet and a weak device
can do. *Cost:* no three things at once on a normal screen. On a very wide
screen (the laptop's 5120×1440 display) Beside could later show two of its
tabs next to each other — only if missed, after living with two.

### Beside holds tabs

Beside has a small tab strip: the things currently on the desk (a PDF, the
folder, Made, a notebook…). One tab is shown; the others are parked warm
with the Open files mechanism that already exists (same budget of six idle
editors, a running notebook never released). A tab name, ✕, and a pin.

**Each tab has its own ‹ back.** A folder in a tab, click a PDF: the PDF
opens in that tab, ‹ returns to the folder at the same scroll. This is how
browser tabs work, so nothing to learn. The browser's own Back and Forward
keep moving the main place only; one Back that sometimes moves the right
side and sometimes the middle is the classic split-view confusion.

### Anything can go beside

A file in the real editor, a PDF at its page, a picture, a video, an
artifact or widget, a change or a whole-turn review, **the folder browser**,
**Made** (what this conversation made), the recent Files list, a project's
summary. Always the real view, placed in the panel — the design/83 rule,
extended from files to every view.

**The conversation itself stays in the main place.** ⇄ swap already makes
it the narrow side on the right when the other thing should be wide; that
covers "the file is the work, the agent beside it". Two conversations side
by side is a different need (comparing agents) and is not part of this.
*Cost:* stated. *Benefit:* the conversation view assumes it is the page in
about 120 places; moving it would be the riskiest change in the app.

### Pinned, or following its conversation

Two kinds of tab, and the difference is visible (the pin filled or not):

- **Following** (the default for what a conversation opens): the tab
  belongs to that conversation. Switch to another conversation and it steps
  aside; come back and it is there again. This is today's per-conversation
  memory, unchanged.
- **Pinned** (📌, or Alt+P as today): the tab stays on the desk wherever he
  goes — another conversation, another project, the project page, home.
  For a file, pinning is the same act as "keep open" (design/77): the row in
  Open files and the pinned tab are one thing, so there is one concept, not
  two lists to keep straight. Pinned non-files (a folder, Made) are kept on
  this device.

The screenshot's case then reads: in the conversation, press ◧ Files → the
project's folder opens **beside**, the conversation stays. Click a PDF → it
replaces the folder in that tab, ‹ goes back. Pin the PDF → it stays while
he answers two other conversations and comes back.

### One right column instead of three

The Files / Made / Artifacts / Programs lists stop being a separate panel
competing for the slot: they are tabs Beside can show. ▤ opens Beside on
whatever it last showed (its lists if nothing else). One place to look on
the right, one ✕, one width.

### Ways in, one rule

- **A click opens in the place you clicked in. Shift+click opens in the
  other place.** In the main place's folder, a click opens the file full;
  Shift+click puts it beside. In Beside's folder, a click opens in the tab;
  Shift+click opens it in the main place. Conversation file links keep
  design/83's choice (a click opens beside, Shift+click full page) — they
  are the one place where the "other place" is the natural default, because
  the conversation is the thing you are in.
- A ◧ button in every view's head: "put beside" (or "bring to the middle"
  when it is beside). The same in each row's ⋯ menu and Open files' menu.
- Keys: **Alt+B** put beside / bring back, **Alt+[** and **Alt+]** previous
  and next tab, Alt+\ swap (exists), Alt+P pin (exists). All free today.

### Each device

- **Wide screens**: the real split, the edge dragged to size, the width and
  the tilt remembered per device (as now). The main place uses its whole
  width while Beside is open; the empty margins in the screenshot go.
- **Phone and narrow windows**: one place at a time, as design/83 does
  today; the tab strip becomes the sheet's header and the pill brings the
  other side back in one tap; Android's back steps Beside aside.
- **E-ink tablet**: no animation; in landscape a real split. A PDF beside a
  handwritten note (design/98) is likely the most valuable pairing on that
  device, and it needs nothing more than this.
- **Weak devices**: only the shown tab is drawn; parked tabs follow the
  existing six-editor budget; a released tab keeps its place in the strip
  and reloads when chosen.

### What is remembered

The desk (its tabs, which one shows, pinned or following, each tab's back
history, the width) is per device and survives a reload. Pinned files are
also in Open files, so they show on every device's list; what is *on the
desk* is per device because a phone and an ultrawide screen want different
desks. The address keeps describing the main place only. *Cost:* a shared
link does not carry the desk (as design/83 already decided).

## Order of work, each step useful alone

1. **Beside outlives the conversation when pinned**, and the project page,
   folder browser and home can have something beside. Mostly the
   route rule in `artifacts.js` (`onLeaveConversation`) plus the pin.
2. **The folder browser can be placed beside**: rendered into a host
   element instead of the page, with its own back. This is the screenshot's
   case and the largest single piece (`files-browser.js` assumes the page in
   `fbCurrent`, its hash and its returns).
3. **Tabs**, on top of Open files' parked editors.
4. **One right column**: the Files/Made/Artifacts/Programs lists become
   tabs; `#rightFiles` and `#artifactPane` merge.
5. **The click / Shift+click rule, ◧ in every head, the keys**, and the
   help sheet; voice commands learn "put it beside".

Each step is tested in a browser like `test/pair.test.js`, at desktop,
phone and e-ink sizes.

## Trade-offs, said plainly

- Two places only; no free tiling, no detached windows.
- The conversation is always in the main place (swap changes widths, not
  that); no two conversations side by side.
- Back moves the main place only; Beside tabs have their own ‹.
- More remembered state means more chances of "where did that go?"; the
  tab strip being always visible while Beside is open is the answer, and
  why tabs are capped (about 8; the oldest unpinned one goes first).
- Pinned folders and lists are per device; only files sync (through Open
  files).
- Parked tabs cost memory; on the e-ink tablet the budget may need to be
  smaller than six. To measure, not guess.

## Decisions this needs (Maxime's)

- **D1** Two places (main + Beside with tabs), not free tiling.
  *Recommend yes.*
- **D2** Pinning a file beside = keeping it in Open files (one concept).
  *Recommend yes.*
- **D3** Fold the right Files/Made/Artifacts/Programs lists into Beside.
  *Recommend yes.*
- **D4** Click opens where you are, Shift+click the other place
  (conversation links keep opening beside). *Recommend yes.*
- **D5** Build in the order above, starting with 1 and 2 together (they are
  what the screenshot needs). *Recommend yes.*
