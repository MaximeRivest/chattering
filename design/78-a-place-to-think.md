# 78 — A place to think: every piece of work shows what it made

*2026-09-28. A study, not a decision; it ends with the decisions it needs.
Written after D5 of design/63 was settled ("my product is Chattering, a
better place to think with AI, and Markdown notebooks are key to that") and a
conversation about Obsidian and GitHub Next's Chopin (01a0ea09).*

*Second version, same evening. The first version made the Markdown page the
unit of work. Maxime: "that can work for some activities, but you're missing
when we are actually doing agentic engineering and creating a lot of
artifacts … the files are mostly coding files … some of the generated
artifacts will be HTML presentations, like in the Rockfrog folder." He is
right, and the correction changes the centre of the design: the unit is the
**piece of work**, and a page is one of the things it can make.*

## Evidence used

- The live app on lambda, screenshotted at desktop and phone size
  (2026-09-28, headless, signed in with the install token).
- Maxime's own description of his working cycle (01a0be8b #0, 2026-09-20),
  the side-list rewrite (design/59), work-first navigation (design/51), open
  files (design/77), artifacts (design/67), delegation (design/29),
  checkpoint reviews (design/36, 38), the original brief (design/00).
- Three kinds of real work, as they look on disk and in the records:
  - **Engineering Chattering:** 271 commits in 30 days across ~70k lines,
    mostly `.js`; each feature leaves code changes, tests, often a design
    note, and an agent message reporting its state in prose ("It isn't live
    yet: restart Chattering", "Fixed and deployed to Lilly's PC and XPS",
    "Commits: MRMD `b7abb0d`, Chattering `b74339e`"). Tonight three
    conversations were changing the same checkout at once.
  - **Making Rockfrog material:** ~1,300 files; six HTML decks sharing one
    style, PDFs, slide PNGs, a video; `README.md` is a hand-kept table of
    every deliverable ("Built from version 39 of this conversation's deck").
  - **functai stage 1:** one lead conversation ("Sessions", 26 turns) drives
    about 30 worker conversations (0 turns each: "Py recheck", "TS repair",
    "R shapes"…) in `~/Projects/.pi-worktrees/`. Its side-list row says
    `29/34 done · 1 to review`. Its Gantt lane is a thicket of short bars.
- Two studies running the same evening: why the MRMD editor "feels 80%
  there" (01a0ea38) and the front end on weak devices (01a0ea39).
- Outside input: tryingET (Obsidian's switcher, Omnisearch, `[[links]]`,
  `![[embeds]]`) and Chopin (document + chat + attributed decisions).

## The cycle Chattering must serve

In Maxime's words (01a0be8b), condensed:

1. **Re-enter.** After time away, the Gantt reminds him what he worked on.
2. **Dispatch.** Open a project or a conversation, give a prompt, send it —
   then start another, and another, while the first ones run.
3. **Be told only one thing:** a run finished or crashed.
4. **Triage.** Click it, read, answer, and get back to where he was.
5. **Deep work in the gaps.** Review a larger change, write or edit a
   document, run code in a notebook, look at what was made.
6. **Note things for later.**

Steps 1–4 are served well. Step 5 is where the product says it is going and
where it is weakest. Step 6 has no place.

## What is right, and stays

- **The side list as a messaging app** (design/59) for steps 2–4.
- **The Gantt as memory** for step 1: a re-entry tool, not the hub.
- **Files on disk are the truth**; Git; per-change accept/reject; shared
  editing; checkpoints after every tool call; rat under notebooks.

## Diagnosis: seven causes under the symptoms

**1. There is no durable unit of work.** Chattering has the conversation
(disposable; 259 in this project) and the project (months, huge). What a
person carries in their head sits between: "the open-files feature", "the
investor deck", "Python repair, stage 1". Today that thing is scattered over
conversations, delegations, code changes, artifacts, and decisions in
transcripts. The Gantt draws the scatter; nothing lets you open it.

**2. What a piece of work made is not visible anywhere.** This is the gap
the first version missed. Reviews are per step group or per turn ("Review
whole turn"); nothing shows the net change of a whole piece of work across
its turns and its delegated workers. Artifacts have a library, but not
grouped by the work that made them. Whether the work is committed, pushed,
live after a restart, or verified exists only as prose in the last agent
message, or as a README table kept by hand. A pull request shows exactly
this for a branch — intent, discussion, diff, checks, previews, state —
and agentic engineering in Chattering is pull-request-shaped work without
the pull request.

**3. Places are organised by kind of object, not by work.** About thirteen
main screens (home/Gantt, conversation, draft, project summary, files
browser, file, change review, tree, epic, note, evidence, usage, settings);
a right panel with Files / Artifacts / Programs, each with its own switches;
a left column with conversations, open files and other processes. Seventy-
eight design notes in five weeks each gave an ability its own place. To find
something, you must first know what kind of thing it is.

**4. One screen at a time, while the work is two things at once.** The
cycle is conversation ↔ what it made ↔ review, over and over; Back is the
glue. The artifact panel is the first side-by-side pair, and it is
read-only and knows only declared artifacts.

**5. Finding is split across five inputs.** `T` (files in one repository,
inside the Files browser only), the search dialog (conversations, notes,
memory), `@` in the composer, the project picker, voice commands.

**6. The surface is "80% there", and thinking needs 100%.** 01a0ea38: the
formatted-view trick makes the layout jump and is patched case by case;
parts of the editor disagree about the cursor; editors on one page share
measurements; 15 of 121 recent commits were fixes. It also found a
**security hole**: HTML inside a document is rendered unsanitised, so a
document an agent wrote could run code inside Chattering. 01a0ea39 covers
weak devices (a large paste can crash the page). tryingET's first issues
were the same family: buttons that did nothing, dead links.

**7. Defaults come from a different product.** Design/00 was a
conversation-archive brief ("mono font everywhere", "density over air").
Documents deserve a reading face and width by default.

## The shape

### Three nouns

- **Work** — one piece of work: its lead conversation plus the
  conversations that belong to it (forks, delegated workers, and any
  conversation started as "continue this work"). Durable; named after what
  it is for. Conversations stay disposable rows in the side list; the work
  persists.
- **Outcomes** — what a work made, of three kinds:
  - **changes** — edits to code and text files in one or more repositories;
  - **artifacts** — made things to look at: decks, sites, PDFs, videos,
    images, widgets;
  - **pages** — Markdown documents and notebooks: plans, design notes,
    READMEs, analyses.
- **Projects** — folders where works and their outcomes live.

A work is not a fourteenth place: it **replaces** places. It is what the
Gantt draws (functai's lane becomes a few bars, not thirty), what a side
list row summarises (today's `29/34 done · 1 to review` chip, generalised),
and what the right panel shows (instead of Files / Artifacts / Programs
tabs that know nothing of the work).

Most membership is automatic from what Chattering already records: forks
and delegations are exact (design/29 forbids guessing them from timing or
folders, and so does this). A new conversation joins a work only when
started from it ("continue this work", the ask box of one of its pages, a
row of its outcome view). Everything else starts a new work; merging two is
one action.

### The outcome view, beside the conversation

```
┌ attention ┬──────── conversation ────────┬──────── this work made ────────┐
│ ● reply   │ you: make the investor deck   │ running · 12 files · 1 to review│
│ ··· run   │ agent: …                      │ ─ changes ───────────────────── │
│ ! crashed │ [9 steps · review]            │  deck/investor.html  +210 −40 ✓ │
│           │                               │  deck/deck.css        +12  −3   │
│ open      │                               │  not committed · not pushed     │
│  files    │                               │ ─ artifacts ─────────────────── │
│           │                               │  investor deck   v12 ◧          │
│           │                               │  rockfrog-deck-investor.pdf     │
│           │                               │ ─ pages ─────────────────────── │
│           │                               │  pitch-guide.md                 │
│           │ ┌ say the word… ────────────┐ │ ─ checks ────────────────────── │
│           │ └───────────────────────────┘ │  export ran · 14 slides ✓       │
└───────────┴───────────────────────────────┴─────────────────────────────────┘
```

- **Changes:** the net difference since the work started, across all its
  conversations and workers, per repository, from the checkpoints that
  already exist after every tool call. Each file: which conversation and
  step changed it, reviewed or not, committed (hash) or not, pushed or not.
  Opening a file opens the change review for the whole work, not one turn.
- **Artifacts:** every declared artifact and every generated output of the
  work (HTML, PDF, video, images), with versions (checkpoints give them),
  opened in the panel's viewers.
- **Pages:** documents the work wrote or edited, opened in the real editor.
- **Checks:** what shows the work does what it should — tests and builds
  the agents ran and their results, screenshots they took, exports, "needs
  a restart to be live". Guessing these from shell commands is fragile;
  agents should **declare** them, as they declare artifacts today (a tool
  like `artifact`), with guesses shown as guesses.
- **State line**, also shown on the side-list row: running · needs you ·
  N to review · committed · live.

Any item opens on the right, beside the conversation: a diff, a deck, a
page in the editor, a live preview of the app. The right side widens or
takes the whole screen with one key. For **thinking work** the same layout
tilts the other way: the page is the wide side, the conversation beside it
(the first version of this note, now one case of the shape). On a phone and
on e-ink: one side at a time, a toggle between them.

### Several agents in one repository

Tonight three conversations were changing `~/Projects/chattering` at once,
and the checkout held other conversations' uncommitted edits. The outcome
view makes this visible: a file changed by two works is marked shared (the
task-location code already detects this, design/38). For work that should
not collide, a work can get its own worktree — as functai already does by
hand in `.pi-worktrees/` — and its outcome view offers "merge back".
*Trade-off:* Chattering runs from its main checkout, so a worktree's
changes are not live until merged; that is a feature for risky work and a
cost for small fixes. Optional, per work.

### One finder

One key everywhere (and the same list for voice): works, conversations,
pages, artifacts (with versions: "investor deck v12"), files, projects,
commands, settings. Ranked by open or running, then recent, then this
project, then the name. Full text inside pages and code, ranked, typo-
tolerant, opening at the line (Omnisearch's lesson). The parts exist:
`mrmd-project` fuzzy search, the FTS5 index, the `T` finder, the voice
action registry.

### Pages, links and decisions

- `[[` suggests pages, works and conversations and **writes a normal
  Markdown link**, so files stay readable on GitHub. Renames fix links
  (`mrmd-project` has the parser, resolver and rename refactor for
  `[[links]]`; it must learn normal links too).
- A page shows **linked here**: pages that link to it and the works that
  made or changed it.
- A work can have a **brief** page — for Chattering features, the design
  note already is one. Chopin's decisions (attributed, kept apart from the
  prose, marked "not rechecked" when the prose moves) belong there, later,
  as comments in the file (`<!--! … !-->`, which MRMD has).
- `![[…]]` embeds later: a page, a section, a cell's output, an artifact.

## Order of work, each step useful alone

0. **Trust first.** Fix the unsanitised HTML (a security bug). Build the
   editor "jank meter" of 01a0ea38 and fix what it finds before adding
   editor features. Sweep dead clicks. Take 01a0ea39's weak-device fixes.
   *Cost: a pause in visible features.*
1. **One finder.**
2. **The outcome view** of one conversation (its turns and its delegated
   workers): net changes with commit state, artifacts with versions, pages,
   and the state line on the side-list row. Built from checkpoints,
   reviews and the artifact index that already exist.
3. **Works:** forks and delegations grouped automatically, "continue this
   work", merge two works; the Gantt and the side list show works.
4. **The pair, both ways:** conversation beside any outcome, and a page
   beside its conversation — with the editable page (the artifact panel's
   "step 2", done properly: an editor that can live in more than one
   place, shared editing independent of the full-screen file view).
5. **Declared checks** (a tool for agents) and "live" state (restart or
   deploy needed).
6. **Links and backlinks**; reading defaults for pages (a reading face and
   width; read mode on phone and e-ink, design/63 step 5).
7. **Live agents and runs that outlive the window** (design/63 rule 5).
8. **Worktree per work**, optional, with "merge back".
9. **Comments and decisions in the file.**

## A surface budget

- One page maps every place in the app and what it is for. Each new design
  note names the place it lives in, or the place it replaces.
- Before removing anything, count route and panel visits locally for two
  weeks (this machine only). Candidates once the numbers are in: the Files
  browser's Browse/Changes/Highlight/By controls (Maxime, 01a0b945: "I'm
  not going into file modes much. It's weird"), the right panel's three
  tabs (absorbed by the outcome view), and rarely used screens the finder
  can still reach.

## How to know it worked

- "What did this make, and is it done?" is answered by looking at the
  row and the outcome view, never by scrolling the transcript or keeping a
  README table by hand.
- The loop from "finished" to reading the answer to being back where you
  were: seconds, not screens. Back/Forward between a conversation and its
  files drops sharply.
- The functai lane of the Gantt shows a few works, not thirty bars.
- Editor jank: zero pixels on the meter's script.
- The stranger test (design/73) grows: ask for something that makes a file
  and an artifact, see both in the outcome view, close the app, and find
  them the next day in under five seconds.

## Trade-offs, said plainly

- **A new noun ("work") must earn its place** by replacing three: the
  per-turn-only review, the work-blind right panel, and the Gantt's
  per-conversation bars. If it only adds, it fails this note's own budget.
- **Membership rules will sometimes be wrong** (a new conversation that
  should have joined a work). Merging must be one action, and nothing is
  guessed from timing or folders.
- **Net changes of a work are harder than per-turn reviews** when several
  works edit the same files in one checkout; they must say "shared" instead
  of pretending to own a line.
- **Declared checks need agents to cooperate**; guessed ones will be wrong
  sometimes and must look different.
- **Step 0 slows visible progress** for a while.
- **Removing places breaks habits** (Lilly's and Jacob's too): measure
  first; the finder keeps everything reachable.
- **A reading font by default changes the terminal look** for pages only;
  chrome and code stay monospace.

## Decisions this needs (Maxime's)

- **U1** — The piece of work, with what it made, as the unit (pages are one
  kind of outcome)? *Recommend yes.*
- **U2** — Step 0 before new editor features? *Recommend yes;* the security
  bug alone justifies it.
- **U3** — The finder's key. Ctrl+K is the file's Ask box; Ctrl+P is free
  in Chattering today. *Recommend Ctrl+P, with `>` for commands.*
- **U4** — How a new conversation joins a work: only when started from it,
  or also suggested by Chattering? *Recommend explicit only, plus a
  one-action merge;* suggestions later if the misses are common.
- **U5** — Checks declared by agents through a tool, or guessed from
  commands? *Recommend declared, guesses shown as guesses.*
- **U6** — Reading face as the default for pages? *Recommend yes.*
- **U7** — Count visits locally for two weeks before cutting places?
  *Recommend yes.*
