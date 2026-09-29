# 82 — What a conversation made

*2026-09-29. Design/78's step 2, asked by Maxime as "the single most
impactful thing": after an agent finishes, "what did it do, and is it done?"
should be answered by looking, not by scrolling a transcript for "Commits:
…" or keeping a README table by hand.*

## What a person sees

**The header chip.** Beside a conversation's title, in a few words:
`± 6 files · 2 to review`, `± 1 file · 1 not committed`, `restart to use`,
or just `± 3 files` when everything is done. It replaces "± changes", which
opened the review directly; a click opens **Made**. Its state is
aria-pressed while the view is open; a second click closes it.

**Made**, the first view of the right panel (beside Files, Artifacts,
Programs; the All / Project switch steps aside because the view follows the
conversation, not a project). From top to bottom:

- **State.** Working (a pulse, "updates as it works") or finished and when;
  when it was last checked, and ↻. Totals: files, commits, artifacts,
  outputs, sub-agents, lines added and removed. Then only what needs a
  person, each in words: *N files not reviewed*, *N not committed*,
  *N commits not pushed* / *branch X is only on this machine*,
  *Restart Chattering to use N changes*, *Reload this page to use N
  changes* (with Reload), *N files changed since*, *N sub-agents failed*.
  Or *Everything reviewed and committed*. **Review all changes** opens the
  whole-conversation review (design/79).
- **Changes**, by repository (the conversation's own first), with the
  branch and its state against its upstream. A repository with several
  working folders (a worktree per sub-agent) shows each as one line to
  open: its branch, the agent that worked there, its file count, what is
  not committed, whether it is pushed. A file row: A / M / D / ?, the name,
  +added −removed, its folder within its working folder, the agent when
  the group has not already said it, and only the states that need a
  person — *restart to use*, *reload to use*, *changed since* / *deleted
  since* / *not on disk now*, *not committed* / *new, not committed* /
  *merge conflict* / *ignored by git*, *✓ reviewed*, *also edited
  elsewhere*, *see its commit* (no saved edit history, but a complete
  committed version), *history incomplete*. "Committed" is not written on
  rows: it is the normal end, and the branch line carries it. A row opens
  the file in the whole-conversation review, open and scrolled to; ↗ opens
  the file as it is now. Files outside any repository, and scratch files
  in temporary folders outside the project, fold under their own lines.
- **Commits** the agents made (branch-work.js's evidence: their own git
  commands, never dates alone), newest first, per repository and branch,
  with commits others put in the same range counted. A commit opens the
  review's Commits view.
- **Artifacts** the conversation's agents declared (design/67), opened where
  they were made.
- **Outputs**: pictures (with a thumbnail), PDFs, pages, web pages and data
  its commands wrote, newest first; code and other files its commands wrote
  folded; files in temporary folders counted, not listed.
- **Also changed while it worked** (folded): workspace changes during its
  steps that none of its steps targeted — another conversation, a person, a
  build. Not proof of authorship, said so.
- **Sub-agents**: each with its state (running, done, failed…), its file
  count, and **report**, the file it handed back.
- **Notes**: what the evidence could not settle (unproven folders, scratch
  repositories left out, unreadable sub-agents).

On a phone the view is the right panel's sheet ("Files" in the bottom bar,
or **What it made** in the conversation's menu). On e-ink every state is a
word; tones become weight.

## Decisions, and what they cost

- **One engine, never a second opinion.** The panel and the saved review
  both come from `task-reviews.js analyseTask` and `conversation-reviews.js
  joinAgents` (split out of `buildTaskReview` / `buildConversationReview`
  for this; the saved reviews are unchanged, byte for byte, and their
  tests pass as before). A row always opens the same file in the review.
  Checked on four real conversations (functai with 76 sub-agents, a Rockfrog
  deck, two Chattering features): the file lists agree exactly (156/156,
  9/9, 28/28, 6/6). Rejected: a lighter list of paths from the tool calls,
  which would have disagreed with the review within a day.
- **Nothing saved to look.** A whole-conversation review is saved each time
  its inputs change; for functai one weighs ~4 MB. Refreshing a panel after
  every turn would have saved hundreds of MB a day. The summary is worked
  out and thrown away; a finished agent's analysis stays in memory while
  its session file and saved checkpoints are the same (the review's own
  signature). The review is saved only when a person opens it. The one
  write left is analyseTask's content-addressed text cache, shared with
  reviews (the same text is stored once).
- **Measured on lambda.** First look: 0.1 s (small), 0.5 s (a deck), 0.8 s
  (28 files, 2 repositories), 3.0 s (76 sub-agents). Again, unchanged:
  10–95 ms. The review of the 76-agent conversation takes 5.4 s every time
  (it re-reads the commits each time; the panel keeps them while the
  commands and the branch heads are the same).
- **The present, cheaply.** Disk: a file's blob id, cached by its stat.
  Git: one `git status --porcelain=v2 --branch` per repository for the
  listed paths, reused while HEAD, the index and those files are unchanged,
  with `--no-optional-locks` so an agent's own git command never meets our
  lock on the index. Reads the default global ignore file so "ignored"
  matches a terminal; otherwise no global configuration, no hooks.
- **"Reviewed" means the version reviewed.** A file is ✓ when a person
  marked it in any review of this conversation (or its sub-agents) *and*
  the version they marked is the version the work produced. A later change
  to the file by someone else is shown separately (*changed since*), it
  does not unmark the review of the work.
- **"Restart to use" is exact.** `module-stamps.js`, required second by
  server.js, records each source file's modification time when this
  process compiles it; a changed file the server loaded before its last
  change needs a restart. Page files: the page compares the files it loaded
  (its resource list and app.html) with their change time — reload, not
  restart. Rejected: comparing with the server's start time, which is wrong
  for modules loaded later, on first use.
- **Scratch is outside the project.** A file in a temporary folder is an
  agent's scratch unless the conversation's project itself lives there.
- **A sub-agent's report goes with the sub-agent.** Files in the
  delegations folder are how a sub-agent hands its result back; counted as
  reports, shown on its row, not among the code.
- **When it asks.** Once when the conversation opens; when its transcript
  changes (at most every 4 s, every 8 s while it works); every 8 s while it
  or a sub-agent works and someone looks; on coming back to the window; ↻.
  Painting the side list never asks. One computation per conversation at a
  time on the server; a second request waits for the first.
- **The Made view opens items where they already open.** A file in the
  review screen, an artifact in the artifact panel, a file in the file
  view. *Cost:* the review and the file view replace the conversation (Back
  returns), and opening an artifact closes the Made list (one right panel
  at a time, design/67). Design/81 (the pair) is where these open beside.

## Limits, said plainly

- **Not on the side-list rows yet.** Design/78 asked for the state on each
  row. It needs a batch summary for every listed conversation and touches
  the side list, which another session is changing now. The header chip is
  the state for the conversation on screen.
- **Worker processes are not checked for restarts.** "Restart to use" knows
  the main server's files, not what `pisdk-worker.js` and the other child
  processes loaded.
- **Pushed means the branch's upstream.** A branch with commits and no
  upstream is "only on this machine"; whether a particular commit reached
  another remote is not checked.
- **Outputs found from shell commands are read from the commands**, not
  observed (a redirect, `cp`, a Python `open(..., 'w')`); marked so on
  hover. Files written by a script the agent ran are not found unless they
  changed a folder with saved steps ("Also changed while it worked").
- **Sub-agents launched before 2026-09-29** have no saved edit history
  (design/79); their files say *see its commit* or *history incomplete*.
- **No checks yet** (tests run, builds, screenshots): design/78 step 5, to
  be declared by agents rather than guessed.

## Where it lives

- `made.js` — the summary: agents' analyses (cached), the join, commits
  (cached), disk, git status, reviewed versions, restart, outputs, counts.
- `module-stamps.js` — when this process loaded each source file.
- `task-reviews.js` (`analyseTask`, `lineCounts`), `conversation-reviews.js`
  (`joinAgents`) — the shared engine.
- `server.js` — `madeSummaries()`, `GET /api/made?key=` (member, and the
  conversation must be visible to the person: policy.js); `status` of each
  sub-agent in `conversationFamily`.
- `made-panel.js`, `made.css` — the view, the header chip, refreshing.
- `app.html` — the tab, `renderRightFiles` (Made renders itself and skips
  repainting when nothing changed), the header chip, the phone menu item,
  `Made.onConversation` after each transcript render.
- Tests: `test/made.test.js` (git status parsing; agreement with the saved
  review; nothing saved; reviewed follows the marked version; later edits
  and commits; caching and coalescing; restart; commits and unpushed
  branches; scratch outside the project), `test/made-app.test.js` (the
  journey in a browser: header chip, view, a row opening the review at the
  file, reviewed and committed showing, the view closing and Files coming
  back), `test/conversation-app.test.js` (the chip opens Made; its files
  match the review's; a sub-agent's file names it).
