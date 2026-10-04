# 95 — Opening and following a long conversation

Status: built 2026-10-04. Follows the low-spec work of 2026-09-28 (the home
page's redraw budget, very long messages) and the navigation fixes of
2026-09-24 (people.js reading position, delegations fetched once).

## The job

*When I open a long conversation, or watch an agent write into one, on any
of my devices (the laptop, the phone's app, the e-ink tablet), it is there
at once and the page stays responsive.*

## What it cost (2026-10-04, the two largest conversations here: ~2,300
## messages, 2.4 MB each; Chromium, CPU slowed 4× for "phone")

| | before | after |
|---|---|---|
| bytes for one open (gzip) | 682 KB | 192 KB |
| a revisit with nothing new | 682 KB | ~1.5 KB, or nothing (drawn from memory) |
| page elements | ~21,000 | 5,200–8,800 |
| open, fast machine | 0.7–1.7 s | 0.13–0.5 s |
| open, phone | 2.5–7.8 s (19 s cold) | 0.5–1.8 s |
| an agent writing (a line every 0.3 s, 15 s), page frozen, fast machine | 25% of the time | no frame over 50 ms |
| the same, phone | 60% of the time, falling behind | ~26%, each write shown within ~0.4 s |
| conversation tree built (per open, per update) | 108 ms | 2 ms |

Measured with ad-hoc scripts (a copy of a real conversation in a test
server, Chrome's CPU throttling and long-animation-frame entries); the
numbers are this machine's, the ratios are what carries over.

## Where the time went

1. **Everything was sent.** Tool calls, their output and the model's
   thinking are ~85% of a conversation's bytes, all inside folded boxes.
2. **Everything was built.** Two thirds of the page's elements sat in
   boxes nobody had opened; another sixth were the hidden items of every
   message's "more…" menu.
3. **Everything was laid out**, on screen or not.
4. **Every live update started over**: fetch the whole conversation, draw
   the whole transcript, wire every button again. 48 full downloads in 15 s.
5. Smaller things: the conversation tree was built in quadratic time; the
   home timeline, hidden behind a conversation, was drawn on every move;
   the page being left was scrolled to its top (a full layout) before the
   next one arrived; the header's auto-hide took the app's own "follow the
   end" scrolls for the reader's and hid and showed the header on each
   update (two whole-page layouts each time); every box's line was watched
   for "stuck at the top", which only an open box can be.

## What changed

**A lean copy** (session-payload.js). `/api/session?lean=1` sends a step
without its words: the folded line's first words, line count and size,
computed by the same expressions the page uses. `/api/session/parts`
sends the words when a step opens, many steps in one request. Kept whole:
user and assistant messages, steps shorter than 200 characters, and the
delegate tool's call and result (its card reads them).

**Only what is new.** A copy carries a token: its message and tree-entry
counts and a hash of them. Sent back as `known=`, the server answers with
what follows when its copy still starts with exactly that, else with
everything. A changed past (another path chosen, a re-index) is caught by
the hash, not assumed away.

**Kept copies.** The page keeps the last few conversations (2, 4 or 8 by
`navigator.deviceMemory`, and at most ~3,000 messages per kept copy). Coming
back to one the list says is unchanged draws it at once and asks the server
afterwards; anything that differs is patched in, or drawn again when the
message box would change.

**Built when opened.** A box of steps is drawn as its line; its rows, and
each step's text, are built when it opens. A MutationObserver on `open`
catches every opener (click, keyboard, voice, find-in-page, scripts)
before the next paint. A message's "more…" menu likewise. Anything that
looks for a step's element (a search hit, an entry link, a return from a
file, the tree, voice) builds the box holding it first (`fillGroupsWhere`).

**Patched, not redrawn.** A block of turns is drawn as pieces separated by
comment markers. A redraw compares the pieces as strings and replaces only
those that changed, so the reader's open boxes, unfolded messages,
selection and scroll survive. Pieces are independent of fold state (boxes
are drawn closed, opened after insertion) so a person's folding never
makes a piece differ. Live updates go through this path. One runs at a
time; the next waits three times what the last one's own work cost here,
at least 0.2 s (1.5 s on e-ink, where a redraw flashes) and at most 4 s.

**Laid out near the screen only.** Assistant messages get
`content-visibility: auto` with a size guessed from their length, then the
size they really had. Not on a person's messages (their actions hang below
the box and would be clipped), and not on an answer whose menu is open.
Long-message folding measures each answer when the browser lays it out
(a ResizeObserver, before that frame is painted). The guess stays under a
screen's height, so a guess never folds.

## Trade-offs, as taken

- Opening a step whose words were left out costs a round trip (one small
  request; "loading…" shows meanwhile). On a slow link that is visible.
- The browser's own find (Ctrl+F) no longer finds text inside steps that
  were never opened: it is not on the page. Chattering's search, which
  searches the server's copy, still lands inside them.
- The scrollbar's size can shift while scrolling far through answers not
  yet laid out (their height is a guess until seen).
- Code that reads a closed box's insides from the page finds nothing until
  it builds the box; every such place in the app does so now (above).
- Tests that read `innerText` see only laid-out answers; one-tree-app turns
  the skipping off for its reads.
- Browsers without remembered intrinsic sizes (Chromium < 98) keep laying
  out everything. Where `checkVisibility` cannot tell a skipped element
  (Chromium < 121), a long answer is folded only once its real height is
  over the limit, which is the same result reached one frame later.
- A search landing still draws its hit from words fetched before drawing:
  one extra request for that open.
- Windowing (drawing only the last N turns) was not done. It would break
  find, selection, reading positions and every landing, which all expect
  the whole transcript in the page; the measures above reach the same
  sizes for conversations of a few thousand messages. Conversations ten
  times longer would still grow linearly.

Found on the way, and fixed: the floating artifact window was fitted to
the window before the phone's bar appeared (the browser reports the media
query change after the resize event) and relied on a later redraw to move
above it; it now follows the bar's size itself.

## What to watch

- `transcriptFragmentPieces` must keep returning one piece per top-level
  item, and a piece's string must depend only on the snapshot (not on
  fold or hover state), or live updates redraw more than they should.
- A new place that queries `[data-eid]`, `[data-i]` or a step button
  inside the transcript must call `fillGroupsWhere` (or
  `fillGroupsWithEntry`) first.
- `session-payload.js` `callHead`/`resultHead` mirror `msgBlock`'s folded
  line; changing one means changing both.
