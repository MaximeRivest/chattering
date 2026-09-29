# 80 — The conversation beside the text

Status: **built** 2026-09-29 (`ask-panel.js`, `ask-panel.css`,
`test/ask-panel.test.js`). Follows the plain ask box (design/33 §12,
"plain by default").

## The moment this serves

A person who barely programs asks for a change to their notebook with
Ctrl+K. The box says "reading the file… 12s" and then "✓ done · changed +5
−8 lines". They want to know what the agent did and what it said. Before,
"details" opened the conversation's page *in place of the file*: the text
they were working on disappeared behind a full technical transcript (tool
calls, arguments, outputs, a composer with model and reasoning pickers).
That is the wrong trade for them: they have to leave their work to learn
about it.

## What was chosen, and what was not

Four shapes were weighed (conversation 2026-09-29): the box growing in
place, a side panel, a panel under the text, notes in the margin. The side
panel won:

- **Grow in place** — no movement at all, but the box covers the text it
  is about and has no room for a real answer. Kept only as its smallest
  part: the box's settled line now carries the agent's own first words
  (the run's final `excerpt`), which answers "what did it say?" most of the
  time without opening anything.
- **Panel under the text** — laptops are short; both the text and the
  conversation get cramped. Rejected.
- **Notes in the margin** — the easiest for non-programmers to follow (each
  request beside the lines it changed), but by far the most to build and it
  needs a wide screen. It can come later over the same data; nothing here
  prevents it.
- **Side panel** — the pattern of Google Docs, Cursor and Copilot, so
  people know it; the text stays visible and changes as the agent works.
  Its cost is width, handled below.

## What the panel shows

- **The conversation as its file continues it**: the path to the file's
  leaf (`ConversationTree` `leafNode`), where an ask's run lands — not the
  full page's reading head, which a person may have moved to an older
  branch. The newest four turns; "show N earlier" adds six at a time.
- **Each turn**: the request as a bubble on the right (long ones clamped,
  "show all"); the agent's work folded into one line of plain words per
  group ("Read this file · Changed this file", repeats counted, at most
  three phrases); what it said between steps in place; its answer. When the
  answer has a simpler version (design/39), that one first, the original
  one click away.
- **Plain words without a model**: every step gets a phrase from its tool
  and arguments (`stepPhrase`): read, change, write, search; a shell
  command by what it does (`rat run` → "Ran code in the notebook", `git` →
  "Checked the project's history", installs, builds and tests, programs),
  the open file named "this file". Instant, free, works with the plain-steps
  setting off. The technical line is the tooltip.
- **Model explanations when they exist**: the groups carry the transcript's
  own group key and step ids (`.toolgroup[data-msg-key][data-gkey]`,
  `[data-step]`, `.tg-detail`), checked against the full page by the test,
  so `PlainSteps.apply` paints explanations a small model already wrote for
  the full page. It does not ask for new ones from the panel (see limits).
- **The run as it goes**, from the page's run ledger (`runLedgers`, fed by
  the same `run-event`s as the full page): the steps being taken ("Reading
  this file…", ✓ for each finished, the last four), the answer as it is
  written (patched per block, so a delta repaints only its own part), the
  step being taken now with the elapsed time, **stop**, and any question
  the agent asks, with the run card's own controls (`updateRunUi`). The
  saved messages of a running turn are left out until it ends, so nothing
  shows twice; at the end the saved conversation replaces the live part in
  one step.
- **A reply box.** It sends through the ask box's own path (`askSubmit`,
  extracted from the box): the same model, reasoning, review-or-apply and
  what-goes-along choices, the file and the cursor's line, the editor
  locked, the changes captured for approval. Its hint line says what will
  happen ("about line 27 · you approve each change"). Enter sends on a
  keyboard; dictation and pasted pictures work; a reply typed and not sent
  survives closing. No send while the agent works on the file (a queued
  ask could not be reviewed: design/33 §13).
- **full page ↗** opens the conversation's own page for everything else.

## How it opens, where it sits, how long it stays

- Opened by: "details" in the ask box (running or settled), "open" and
  "open conversation" in its options view, a new quiet "conversation" link
  in the box's head (when the ask goes to an existing conversation), the
  banner's "details" while the text is locked, and the notice shown when the
  box was closed at the end. Opening it closes the box (its draft is kept):
  the panel says everything the box said.
- The app's right column, the slot of the Files list and a docked artifact:
  one at a time. Opening the panel closes the Files list; opening the Files
  list hides the panel until it closes. Width dragged at the left edge
  (arrows on the edge from the keyboard), 420px by default, kept per device
  (`chattering.askPanel.width`); the text keeps at least 420px. Too narrow
  for both (under 1040px with the side list): it lies over the text. The
  top-bar layout makes room on the right. A phone: a sheet over the screen,
  under the phone's own sheets, closed by Android's back button. The
  floating voice button moves beside it.
- It belongs to the file: it closes when the file closes and comes back
  with it — after "full page" and Back, after a reload — until ✕ or Esc
  (sessionStorage, per tab). An ask from this file to another conversation
  (a new one) switches it to that conversation.
- The file head folds History, Ask and Run under ⋯ by its **own** width
  now (a container query in `live-file.css`), not the window's: the panel
  narrows the file without narrowing the window, and the head wrapped.

## Limits, stated

- The panel reads the plain-steps explanations the full page asked for; it
  does not ask for new ones itself. `plain-steps-ui.js` observes groups
  inside `#view` only and was being reworked at the time; when it observes
  any scroll container, the panel's groups are already in its format.
- One conversation at a time. A file asked about in several conversations
  shows the one of the last ask or of the link clicked; the full page's
  list and the box's options reach the others.
- Pictures in earlier requests are counted ("2 pictures"), not shown.
- A conversation written by a terminal (not a web run) refreshes on the
  page's `update` event after a short pause, without a live view.
- Answers longer than 60,000 characters are cut in the panel, with a note;
  the full page has them.
