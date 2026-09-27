# 75 · The first open: welcomed, then home that shows something

*2026-09-27. Follows design/73 (connect an AI, a first reply). Modules
`welcome.js`, `timeline-chart.js`, `settings.js` (version 3); route
`POST /api/settings/welcome` (owner tier); tests `first-open-history`,
`timeline-axis`, `project-gantt`, `settings`, `fresh-install`.*

## The problem

A newcomer tested 0.1.2 on a Windows PC and never saw the welcome. Her
computer already held four Pi conversations from June and July and five
Claude Code projects. The welcome was only shown when home was *empty*, so
she got the other path: the chart, with no word about what was found or
what to do. The chart made it worse:

- **It opened on the saved zoom, pinned to "now".** Her last activity was
  weeks ago, so the screen showed empty days. Everything she had was off
  screen to the left.
- **A short history opened on empty future.** When all of history is
  narrower than the screen, "now" sat at the left edge and the rest of the
  screen was blank days ahead (seen in the stranger photographs too).

Old history is common: someone who tried Claude Code in the spring and
comes back in the autumn. It has to look alive, not dead.

## Decisions

### The welcome is the first open, not the empty home

- **Shown once per install, on its first open, with or without history.**
  `settings.welcome.doneAt` remembers it was done. An empty home is always
  the welcome, as before.
- **With history, it says what it found**: "Chattering found 214
  conversations already on this computer, from Pi and Claude Code." Step 3
  becomes "Your conversations" ("See my conversations" or "New
  conversation"), and "Skip the welcome" leaves it at any step. A new
  conversation, "Work in a folder…", seeing the conversations, or skipping
  are all "done".
- **Existing installs are not welcomed on update.** Settings version 3: a
  version 2 file, or an older one on a machine that ran Chattering before,
  migrates as done (`doneAt: 'before-welcome'`). Nothing else changes.
- **It can be shown again.** Settings → AI accounts → "Show the welcome
  again" (owner; saved), and `?welcome` in the address (this visit only,
  nothing saved). For testing, and for showing Chattering to someone.
- **Owner only.** The welcome's steps are the owner's decisions. A member
  sees it only on an empty home, as before.

### Home opens on recent work

- **A newly opened chart frames recent work**: the last ten conversations or
  the last three days *of activity*, whichever is shorter, at least two
  hours, with a little room before the first mark. Long conversations
  count from their last day. The same rule frames a project's chart the
  first time it opens (it used to show "the last week", which is empty for
  a project last touched in spring).
- **A chosen zoom is kept**, unless it would show nothing but quiet time
  (no mark ends in the view it would open on). Then the chart frames recent
  work instead. Someone who uses Chattering daily sees no change.
- **"Now" is always at the right edge.** When history is narrower than the
  screen, the days before it fill the left instead of empty future filling
  the right.

### Quiet time is collapsed

- A stretch of **at least three days with no activity** becomes a **break**
  once it would be wider than 48 pixels: a faint band with a zigzag seam,
  labelled with how long it lasted ("4 weeks"), and a tooltip ("Nothing
  happened for 4 weeks"). Old work and today sit on one screen.
- **The break's width is `min(its width to scale, 48 px)`.** It shrinks to
  scale when zoomed out and never jumps: positions are continuous in the
  scale, so zooming stays smooth (the zoom work of 2026-09-21 is kept).
- **"Three days of activity" skips quiet time**, so the framing rule means
  the days someone actually worked.
- Grid lines are not drawn inside a break. A date label that would run into
  a break's label gives way.
- The home chart and the project chart use it. The notes chart does not
  (it has no "now" to be far from).

## Trade-offs, stated

- **A break bends time.** Distances across it are not to scale. The seam,
  the band, the label and the tooltip say so. A three-day threshold means
  a long weekend stays to scale; shorter gaps never collapse.
- **One more settings version.** An install that was mid-welcome on 0.1.x
  (a version 2 file) is counted as done; it keeps the "Connect your AI"
  line above its conversations, which is where it was.
- **The welcome counts conversations, not people.** A shared computer's
  history is "found" as a whole; the words say "on this computer", which is
  accurate.
- **The framing uses the last ten conversations.** Someone with a burst of
  fifty short conversations today sees only the last ten framed; the rest
  are a scroll to the left. Ten is a guess at "readable on one screen",
  not yet checked against a busy real history.

## Next (agreed, not built yet)

1. **Example conversations** when history is missing, or old and thin
   (fewer than about 5 conversations in the last 14 days). They would be
   real, continuable conversations about what Chattering does well (a note
   that becomes a document, a small web page, two AIs side by side, a
   notebook that runs, finding something again), made through Pi's own
   session code at install. They would be timestamped at install time (no
   invented history), marked "Example", in their own row, kept out of
   memory, usage, unread and default search, and removable in one action.
   Chattering would offer to remove them once the person has about five
   conversations of their own.
2. **A Chattering folder** (Documents/Chattering; ~/Chattering on Linux).
   New loose conversations would work there instead of the whole home
   folder. It would contain a living "Start here" document that opens as the
   first item in the sidebar.
3. **"What would you like to think about?"** as the welcome's last step: the
   answer becomes a folder with its conversation and a notes document
   opened beside it.
4. **Existing logins found** (Claude Code, Codex) and offered in one click;
   an honest "I don't have one" path.
5. **Hints at the right moment**; the background-helpers question asked in
   context; machinery (machine name, Gantt, token counter) hidden until it
   is needed.
6. **Signed installers and Git for Windows bundled.** These need
   certificates and an Apple developer account.
