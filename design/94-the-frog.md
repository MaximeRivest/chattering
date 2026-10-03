# 94 — The frog: a piece of Chattering beside any text

Status: built 2026-10-03 for Linux Wayland desktops with the layer shell
(made on Hyprland). Follows design/93 (hotkeys): the same spells, the same
computer link, the same helper. The look was settled in a demo first
(`design/frog/demo`, the mascot's making in `design/frog/README.md`).

## The job

*When I select some words anywhere on my computer, let me act on them with
my own AI programs without remembering a single key, see what would change
before it changes, and tell the program when it got it wrong.*

Hotkeys (design/93) did the first part for people who remember keys. Most
people do not. Grammarly's answer, a button that pops up on every
selection, is the right shape and the wrong manners: it gets in the way of
selecting to copy, it covers the text, it rewrites without showing. The
frog keeps the shape and changes the manners.

## What a person sees

1. They select a few words with the mouse. After a third of a second of
   stillness, the frog hops in beside the end of the selection, waves, and
   waits (it breathes and blinks). Ignored for five seconds, it hops away.
2. Clicked (or called with its key, Super+Ctrl+M by default), it opens its
   **book**: a Chattering panel with the person's spells, each with a
   letter, and a line to ask anything about the text.
3. A letter, a click or Enter casts. The frog reads its book with sparkles
   while the program works; Chattering's own "working" line sits beside it.
4. The **answer** opens: a correction as its changes (removed words struck
   before what replaces them), a rewrite (shortened, translated) as its new
   text, either switchable; the program, its version, the model and the
   time in mono; **Right? ✓ ✗**; then Again, Copy, and the one thing to do
   (Replace, Copy, or Done). Enter does it; Esc closes, nothing changed.
5. Replaced: the frog cheers, "Replaced · Ctrl Z undoes it", and leaves.

It looks like Chattering because it is Chattering's: its tokens
(`design/tokens.css`), Inter and IBM Plex Mono, the Rockfrog mark, its
list rows with the green edge on the current one, its composer for the ask
line. The person's chosen theme (settings → hotkeys → looks) follows them
to every computer; Rockfrog follows the desktop's light or dark.

## The pieces

```
  the app (any)          the helper (node)                 the page (web)
  ─────────────          ─────────────────────────────     ─────────────────────
  selection ──primary──► when, where, what  ◄──JSON──►     host-gtk.py: a layer
  paste ◄── Ctrl+V ───── replace, safely                   over the screen, the
                         │                                 pointer only on the
                         └── device routes ──► Chattering  frog and its panels
```

- `overlay/spells.html|css|js` — the page. It draws and reports; it holds
  nothing of the person's text beyond what it shows.
- `overlay/spells-text.js` — the changes as shown, rewrite or correction,
  edges kept, icons and letters (shared with the helper, tested in node).
- `overlay/host-gtk.py` — the Linux host: wlr layer shell (Hyprland, Sway,
  KDE Plasma, niri, COSMIC; not GNOME), WebKitGTK 6, see-through. One
  layer the size of the screen the selection is on; its input region is
  only the rectangles the page reports, so clicks anywhere else go to the
  app below. Keyboard: none while the frog waits (the app keeps its focus
  and its selection), exclusive while a panel is open, none again after.
  Light or dark comes from the freedesktop appearance portal, live.
- `hotkeys-device.js` (`createFrog`) — when it appears and where, casting,
  asking, judging, replacing; the host's life.
- `hotkeys-desktop.js` (Hyprland) — the primary selection watched
  (`wl-paste --primary --watch`, no copy, the clipboard untouched), the
  pointer, screens, a window's rectangle, giving a window the keyboard,
  how to start the host.
- Server (`hotkeys.js`, `server.js`): the frog's settings per person; spells
  without keys (the book only); `selection_ask`, Chattering's own program
  for a question typed into the book, which also says whether its answer
  replaces the text; judging from the frog.

## Decisions

- **When it appears.** A selection of at least two words (settings: 1–8),
  still for 250 ms (a drag does not summon it), not over 20,000 characters,
  not in an app it stays away from: terminals by default (people select
  there to copy), any app by name. Nothing while a panel is open or a spell
  works. It leaves when the person moves to another window or workspace,
  presses a hotkey, or ignores it.
- **Where.** A mouse selection ends under the pointer: the frog stands
  there, feet on the line, to the right (to the left near the screen's
  edge). A pointer outside the focused window means the keys made the
  selection: it waits in the window's corner. Exact placement from the app
  (a browser extension, the accessibility system) is the next layer.
- **The selection is read, not copied.** The primary selection is what the
  app offers the moment text is selected; reading it leaves the clipboard
  as it was. It stays in the helper's memory and goes to Chattering only
  when a spell is cast.
- **Replace safely.** The keys go back to the app, and the helper focuses
  it itself (the desktop's active window never changes while the book has
  the keyboard, so nothing says when the app has it again); then the
  selection is copied once more and compared with the text the spell
  worked on. Only if they are the same is the answer pasted over it. If
  the selection changed (the person clicked elsewhere), the app did not
  take the keyboard back, or the paste failed, the answer waits on the
  clipboard and the frog says so. Some apps keep offering the old primary
  selection after a click elsewhere; trusting it would paste a duplicate.
- **Letters or typing, never both.** In the book, a letter casts. Tab (or a
  click) moves to the ask line, where letters type and the badges dim.
- **A correction shows its changes, a rewrite its text.** Share of the
  original's words kept (case and punctuation ignored): at least 60 %, the
  changes; less, the new text. One click switches. Removed runs keep their
  spaces and line breaks, so a long removal wraps like text (the first
  demo glued removed words together and ran off its panel).
- **Judging is the program's.** ✓ / ✗ write to the FunctAI call log as any
  rating; the answer joins the program's answer key on its page. A
  computer may judge only answers it was given (kept in memory, 200 per
  computer).
- **One helper does both.** Hotkeys and the frog share the helper, its
  credential and its one-at-a-time rule; a hotkey press sends the frog away.
- **Spells are hotkeys without keys.** A hotkey may now have no keys: it is
  then only in the frog's book. Each has "in the frog's book" on by default
  (selection spells only). Two starters live in the book only: *Make it
  shorter*, *Make it more polite*.
- **Saving the list.** settings → hotkeys saves the whole list with the
  version it was read at; a save from a stale page (another tab or device
  changed it meanwhile) is refused and the page shows the list as it is.

- **Fast.** The host starts with the helper, not on the first selection
  (1–2 s); the desktop is asked everything at once (about 30 ms); the
  layer stays up, empty and click-through, for a minute after the frog
  leaves, since showing it again cost about 200 ms of drawing; the hop in
  is 0.28 s from a visible start. Measured on the laptop (5120×1440): drawn
  60 ms after the selection settles, 200 ms the first time in a session.
  The helper logs this for every frog (no text).
- **Clickable where it is.** The page reports its pointer region from the
  layout, not from the animation's frame (measured mid-hop, the first build
  made a fifth of the frog clickable), on a timer (a page whose screen
  sleeps gets no animation frames), and again on every change. Until the
  layer has its size (a layer just shown measures 0 by 0), the page uses
  the screen size the helper sends.

## Trade-offs, stated

- **The overlay lingers.** For a minute after the frog leaves, an empty
  see-through layer stays over the screen (no pointer, no keys). It may
  keep a full-screen game from the compositor's direct path for that
  minute.

- **It watches selections.** The helper sees the text of every selection
  of two words or more on that computer, in memory, to decide whether to
  show the frog; it keeps none and sends none until a spell is cast. Turn
  the frog off (settings) and it watches nothing.
- **Linux with the layer shell only.** GNOME has no layer shell; X11 has no
  primary-selection watch of this kind. macOS (a non-activating panel with
  a WKWebView, the Accessibility permission for the selection) and Windows
  (a WS_EX_NOACTIVATE window with WebView2, UI Automation) can host the
  same page; their hosts are not written.
- **The host needs native libraries**: GTK 4, gtk4-layer-shell, WebKitGTK 6,
  PyGObject. Machines from the os flake get them (`hm/chattering.nix`,
  `CHATTERING_OVERLAY_HOST`); elsewhere the helper says what to install.
- **Position is a good guess, not a measure**: under the pointer for mouse
  selections, the window's corner otherwise.
- **The selection briefly passes through the clipboard on replace** (the
  check before the paste, and the paste), as the hotkeys do; the clipboard
  is put back.
- **The overlay covers one screen while the frog is out**, see-through and
  click-through outside the frog and its panels. It exists only while the
  frog is out.
- **What a spell reads is recorded in its program's log**, which the
  household sees (design/74), as for hotkeys.

## Verified

- `test/spells-text.test.js`: the changes (removed before added, spaces and
  line breaks kept in a removed run, the answer exactly the kept and added
  parts), rewrite or correction, edges, icons, letters.
- `test/spells-page.test.js`: the page in Chromium with a recording host:
  the frog where it is told and nothing else clickable, the book asking for
  the keys and casting by letter, a long multi-paragraph rewrite shown as
  text and, switched to its changes, every word inside its panel; judging,
  Enter replacing, Esc closing, the ask line taking letters as text, a
  problem said plainly, the dark theme.
- `test/spells-frog.test.js`: when it appears (settled, enough words, not
  in terminals, not when off), where (pointer, or the corner), a spell and
  its facts, a question and Again, the safe replace (pasted with the edges
  kept over the same selection; the clipboard when the selection changed
  or the app did not take the keyboard back), judging, a hotkey press, its
  own key (the book open even in a terminal; nothing selected said so).
- `test/hotkeys-app.test.js`, extended: the frog's settings reaching the
  computer, a keyless spell in the book and never bound, a question typed
  into the book answered by `selection_ask`, judging only one's own
  answers, a stale save refused, the computer's word about its frog shown.
- On Hyprland 0.56 (lambda): the host maps a see-through layer over the
  screen, the page's messages flow both ways, the keys go to the book and
  back to the window when it closes; when a host dies holding the keys,
  nothing has them, which is why the helper gives them back itself.
  Clicking and typing into the real overlay was not possible there (no
  keyboard or pointer attached during the build): the first press is a
  person's.
