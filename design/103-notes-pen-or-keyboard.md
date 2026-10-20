# 103 — A note, by pen or by keyboard

## The ask (2026-10-20)

> Make a very nice UX so that the handwritten note button […] could be
> handwritten with a pen but also handwritten with a keyboard. What are the
> questions we should ask that are relevant in human-computer interaction,
> and the answers we need to give, so that we do the best possible job?

The questions were asked and answered in conversation; Maxime chose the
option below ("C": the first input picks the kind, each kind can hold the
other) and asked for it designed and built in full.

## The questions, and the answers this build gives

| Question | Answer |
|---|---|
| What is the person doing when they press the button? | Putting a thought down, now, in the project in view. Time to the first mark is what counts; nothing to choose or name first. |
| Is "pen or keyboard" a kind of thing or a way of writing? | A way of writing. The button is **✎ Note**, not "Handwritten note". |
| When does the person choose between pen and keyboard? | Never up front. The note opens as what the device suits; the **first mark** decides. |
| One page for both, or two kinds of file? | Two kinds (a page `.ink.svg`, a typed note `.md`), each able to hold the other: typed text on a page; a page as a picture in a typed note. |
| What does typing on a page do? | Types. Text goes where you just tapped, else under the writing. No letter is a tool any more (the old E, L, P, 1 2 3 were mode errors waiting to happen); tools moved to Alt. |
| Can every device find it? | Yes: ✎ beside **new** in the side list on every device (it waited for a pen before), ✎ Note in the ▾ menu and in a project's files, **N** from anywhere. |
| Where do notes go, what are they called? | `<project>/documents/notes/` (or `~/notes/chattering/notes/`), both kinds, named by the person's clock. Older notes stay in `documents/handwritten/` so their links keep working. |
| Is typed text and read handwriting the same to the AI? | No. Typed text is exact (in the SVG as text, in the `.md` as itself); handwriting read by a model will be marked as read (design/98, "Read the writing"). |
| What breaks on each device? | E-ink: interactive controls never sit over the writing area (they would be holes in the fast pen); the typed note's caret does not blink. Phone: a page's typed text is as small as its writing, so a phone opens typed notes. Keyboard only: every text on a page is reachable by Tab, Enter changes it, Delete removes it. |

## What a person does

1. **Start.** ✎ (side list), ✎ Note (▾, a project's files) or N. On a
   device where a pen has been used (always on the e-ink tablet) a page
   opens; elsewhere a typed note, its editor already listening.
2. **The first mark decides.**
   - A page that is still empty says so ("Write with your pen, or start
     typing: the note becomes a typed note") and its toolbar has
     **⌨ Type instead**. The first key typed (or the button) makes it a
     typed note: the page goes, the same stamp becomes `….md`, and every
     key typed meanwhile is in it, caret where it was.
   - A typed note that is still empty says "A typed note" with
     **✎ Write by hand instead**; a pen touching it does the same.
   - Once anything is in a note, it keeps its kind. To go back, empty it.
3. **Typing on a page** that has writing on it:
   - tap where the text goes (the tap's dot gives way to the text), or
     just type: it goes on the next line under the writing, at the margin;
   - the **Text** tool (Alt+T): a tap places text, a tap on a text opens it
     to change (for a keyboard on screen: the tap opens it);
   - Esc (or Ctrl+Enter), a click away, the pen writing elsewhere: done.
     One undo step per text;
   - paste puts the clipboard's text there the same way;
   - the eraser takes a text whole, as it takes a line; Select circles
     texts with the lines, to move, delete, copy or ask about them.
4. **Keys on a page**: typing types. Alt+W pen (again: the next of the
   three), Alt+E eraser, Alt+S select, Alt+T text; Ctrl+Z / Ctrl+Shift+Z;
   Tab to a text, Enter changes it, Delete removes it. The `?` help shows
   them while a page is open.

## Decisions

**Two files, not one mixed page.** A typed note is plain Markdown: it
reflows on a phone, every editor and agent reads it, it has the document
editor's tools (AI commands, notebooks, search). A page stays a fixed A4
for the pen. One mixed format would either cramp typing (text boxes on a
fixed page, tiny on phones) or cramp the pen (drawings as islands in text,
wrong for the tablet). *Rejected*: a single page with text boxes (OneNote's
model) as the only kind; text with embedded drawings (Apple Notes) as the
only kind.

**The device picks what opens; the first mark picks what it is.** A
keyboard person should not meet a page and a pen person should not meet a
text box. The penSeen signal already existed (a pen used on this device; the
tablet always). *Rejected*: a chooser ("page or text?") on every note —
a decision before the first word, every time.

**Changing kind only while empty, on the server.** `/api/notes/convert`
(ink-notes.js `convert`) makes the other file with the same stamp in the
same folder, then removes the empty one only if it is still empty (read
again just before). A note another device wrote in meanwhile is refused
(409) and stays; the text typed here then goes on the page as a typed
text, so nothing is lost either way. The side list and the history entry
follow the new file (Back never leads to the file that went). The doc-edit
ledger records the creation and the removal.

**Keys land, always.** The first key on an empty page focuses a textarea
during the key press, so the browser itself types the key there (dead
keys, AltGr, any layout), and the following keys too while the server
answers; the typed note takes the text and the caret over. The same
textarea, focused inside a tap, is what lets a phone's or the tablet's
on-screen keyboard open. A composition still running (an IME) is waited
for before the hand-over.

**Typed text on a page is an SVG text, under the ink** (ink-format.js):
`<g data-ink-layer="text">`, one `<text data-ink-typed>` per block, one
`<tspan>` per line as it shows, `data-soft` on a line that only wraps the
one before. Any viewer shows it; Chattering gets the exact text back
(the lines joined, a newline before each line that is not soft). A block
is never changed in place: an edit is the old block out and the new one in,
so two devices merge typed text as sets, as they merge strokes; one block
edited on both sides keeps both versions. Text sits on the paper's ruling
(lines every 44 units, grid and dots every 40), 22 units high (≈13 pt on
A4), in the system's sans-serif.

**Saved while typing.** The text being typed is written with the note at
every save (a few seconds after a key), not only when it is finished; undo
gets one step for it when it is.

**No control over the writing area.** "Type instead" was first a button on
the page. On the AINOTE the app's fast pen covers the writing area, and
anything over it must be a hole the app leaves to the page; an app before
0.3.8 gives the whole area back to the slow page while anything covers it.
So the page shows words only (the pen writes over them; they go with the
first line) and the button is in the toolbar.

**Person's notes are not AI notes.** `~/notes/chattering/notes/` sits
beside the distilled notes, which search and records label as AI-written.
The search index skips `notes/` and `handwritten/` there. Notes join project
memory through design/98's "Read the writing" and "Into the project", with
their own label.

**A race in Open files, found on the way.** Letting go of a file whose
"keep" was still on its way to the server sent nothing (the server did not
have it yet), and the server then kept it: a note that became a typed note
at once stayed listed under the old file's name. open-files.js now counts
the batch in flight.

## Trade-offs, stated

- **The first pen line on an empty typed note is not drawn**: that touch
  turns the note into a page, and the pen writes from the next line on.
  It happens on a device the first time a pen is used there (after that,
  notes open as pages on it).
- **A note that has something in it keeps its kind.** Typed notes do not
  turn into pages with their text, nor pages into Markdown; the way back is
  to empty the note. Turning handwriting into text is design/98's reader.
- **A page's typed text is as small as the page on a phone**, and typing
  it there is small too. Phones open typed notes; a page on a phone is for
  reading what the tablet wrote.
- **The textarea's caret blinks on e-ink** (each blink is a small panel
  refresh): a page cannot stop the system caret. The typed note's editor
  draws its own caret, held still in the e-ink theme.
- **Tool letters are gone.** A person who used E, L, P or 1 2 3 on a page
  now uses Alt+E, Alt+S, Alt+W. L and P stay the app's (voice, keep open);
  digits are tab switching in some browsers.
- **N in a conversation with search marks walks the marks back** (as it
  did); anywhere else it makes a note.
- **Outside Chattering**, typed text shows in the viewer's own sans-serif,
  so a line may run a little longer or shorter than on the page; the text
  is exact either way.
- **A typed note shows a page only as a picture** (`![](….ink.svg)`, the
  whole page). Inserting a drawing from inside a typed note, cropped to what
  was drawn, is not built.

## Files

`notes.js` (the button, the kinds, converting), `ink-notes.js` (folders,
create, convert), `ink-format.js` (typed text in the file, wrapping,
merging), `ink-editor.js` (typing on a page, the Text tool, keys, the empty
page), `ink-editor.css`, server.js (`/api/notes/new`, `/api/notes/convert`,
the search index skipping a person's notes), open-files.js (the race).
Tests: `test/notes-browser.test.js` (real keys and pen events, end to
end), `test/ink-notes.test.js`, `test/ink-format.test.js`.
