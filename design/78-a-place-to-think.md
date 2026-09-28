# 78 — A place to think: pages first, conversations beside them

*2026-09-28. A study, not a decision; it ends with the decisions it needs.
Written after D5 of design/63 was settled ("my product is Chattering, a
better place to think with AI, and Markdown notebooks are key to that") and a
conversation about Obsidian and GitHub Next's Chopin (01a0ea09).*

## Evidence used

- The live app on lambda, screenshotted at desktop and phone size
  (2026-09-28, headless, signed in with the install token).
- Maxime's own description of his working cycle (01a0be8b #0, 2026-09-20),
  the side-list rewrite (design/59), work-first navigation (design/51), open
  files (design/77), artifacts (design/67), the original brief (design/00).
- Two studies running the same evening: why the MRMD editor "feels 80%
  there" (01a0ea38, mrmd-packages) and the front end on weak devices
  (01a0ea39).
- Outside input: tryingET (first outside installer; an Obsidian user) asking
  for Obsidian's quick switcher, Omnisearch, `[[links]]` and `![[embeds]]`;
  Chopin (github.com/githubnext/chopin, MIT), studied in 01a0ea09.

## The cycle Chattering must serve

In Maxime's words (01a0be8b), condensed:

1. **Re-enter.** After time away, the Gantt reminds him what he worked on.
2. **Dispatch.** Open a project or a conversation, give a prompt, send it —
   then start another, and another, while the first ones run.
3. **Be told only one thing:** a run finished or crashed.
4. **Triage.** Click it, read, answer, and get back to where he was.
5. **Deep work in the gaps.** Review a larger change, write or edit a
   document, run code in a notebook.
6. **Note things for later.**

Steps 1–4 are served well today. Step 5 is where the product says it is
going ("a better place to think") and where it is weakest. Step 6 has no
place at all.

## What is right, and stays

- **The side list as a messaging app** (design/59): working dots, bold
  unread, ✕ to close, one list on every device. It matches steps 2–4.
- **The Gantt as memory** for step 1. It is a re-entry tool, not the hub.
- **Files on disk are the truth**, Git history, review with accept/reject
  per change, shared editing, rat underneath notebooks.

## Diagnosis: six causes under the symptoms

**1. There is no durable unit of thought.** Chattering has two scales:
the conversation (minutes to hours, disposable, 259 of them in this project
alone) and the project (months, huge). What a person carries in their head
sits between the two: "the Obsidian-UX question", "Python repair, stage 1",
"the pitch deck". Today that thing is scattered over many conversations (the
functai lane of the Gantt shows about twenty for one effort: S1 review, Py
S1 rev, R S1 rev, …), a few files, some artifacts, and decisions buried in
transcripts. The Gantt draws it, but it cannot be opened, written in, or
continued. Design/41 already states the answer at a small scale: *"The
conversation is a trace; a notebook is a document."*

**2. Places are organised by kind of object, not by work.** The main area
has about thirteen screens (home/Gantt, conversation, draft, project
summary, files browser, file, change review, tree, epic, note, evidence,
usage, settings). The right panel has Files / Artifacts / Programs, each
with its own All/Project switch and filters. The left column holds
conversations, open files and other processes. Seventy-eight design notes in
about five weeks each gave a new ability its own place. To find something, a
person must first know what kind of thing it is. Obsidian works because
there is one kind of thing (a note) and one way to reach anything (the
switcher).

**3. One screen at a time, while the work is two things at once.** The
cycle is conversation ↔ file ↔ review, over and over. The main area swaps
whole screens; Back and Forward are the glue (design/44 built an excellent
Back because of this). But the work itself comes in pairs: *this*
conversation about *that* document, *this* review of *that* change. The
artifact panel is the first side-by-side pair, and it is read-only.

**4. Finding is split across five inputs.** `T` finds files in one
repository, only inside the Files browser; the search dialog finds
conversations, notes and memory; `@` in the composer finds projects and
conversations; the project picker finds projects; voice commands have their
own action list. Each knows a part.

**5. The surface is "80% there", and thinking needs 100%.** A person
writing a thought cannot have the line jump, the cursor land elsewhere, or a
click do nothing. 01a0ea38 found why the editor feels unfinished: the
formatted-view trick makes the layout jump and is patched case by case;
parts of the editor disagree about where the cursor is; editors on one page
share one set of measurements; only 15 of 121 recent commits were fixes. It
also found a **security hole**: HTML inside a document is rendered
unsanitised, so a document an agent wrote could run code inside Chattering.
01a0ea39 is measuring the weak-device side (e-ink: 4 GB, one core; a large
paste can crash the page). tryingET's first issues were the same family:
buttons that did nothing, dead links, a lost line on reload.

**6. Defaults come from a different product.** Design/00 was the brief for
a conversation archive used by one developer: "terminal-native", "mono font
everywhere", "density over air", "dark only". Those fit reading
transcripts. A place to think in documents wants prose in a reading face at
a reading width. The option exists since 2026-09-23 (document font and
width); the default is still monospace across the whole window.

## The shape

### Three nouns

- **Pages** — Markdown documents and notebooks (and, by extension, any
  file). Durable, on disk, the person's. Thinking lives here.
- **Conversations** — traces of work with an agent. Disposable, listed by
  attention. Usually *about* something: a page, a project, or nothing.
- **Projects** — folders where pages and conversations live.

(People and devices stay as they are.)

No new "workspace" or "thread" object. That would be the fourteenth place.
What ties a conversation to a page is **derived from data Chattering already
records**: the conversation was started from the page (the ask box does this
today) or edited it (the file ledger knows). Reading a file does not count,
or an agent that reads thirty files would belong to thirty pages.

### One pair on screen

```
┌ attention ┬──────────── page ─────────────┬──── conversation ────┐
│ ● reply   │ # Stage 1 repair               │ you: why does R ...  │
│ ··· run   │ prose, decisions, open points  │ agent: ...           │
│ ! crashed │ ```python                      │ [3 steps · review]   │
│           │ df.head()   ▶                  │                      │
│ open      │ ```                            │                      │
│  pages    │ output …                       │ ┌ say the word… ───┐ │
│           │ linked here: 2 pages, 5 convs  │ └──────────────────┘ │
└───────────┴────────────────────────────────┴──────────────────────┘
```

- A page with its conversation beside it, or a conversation with the page
  it is working on beside it. One key swaps which side is wide; either side
  can be alone.
- The page side is the real editor: type, run cells, see the agent's
  changes arrive. This is Chopin's screen (document + chat), except the
  document runs code.
- On a phone and on e-ink: one side at a time, a toggle between them.

### One finder

One key everywhere (and the same list for voice): pages, conversations,
projects, commands, settings. Ranked by what is open or running, then
recent, then this project, then the name. Full-text inside pages is part of
it (Omnisearch's lesson: rank, tolerate typos, show the snippet, open at the
line). The pieces exist: `mrmd-project` fuzzy search, the FTS5 index
(`searchindex.js`), the `T` finder, the voice action registry. One list, not
five.

### Links that make pages a web

- `[[` suggests pages (and conversations) and **writes a normal Markdown
  link**, so files stay readable on GitHub and in any editor. Renames fix
  links. `mrmd-project` has the parser, the resolver and a rename refactor
  for `[[links]]`; it must learn normal links too.
- Every page shows **linked here**: pages that link to it, and the
  conversations tied to it (above). Obsidian has backlinks between notes;
  Chattering can also show the agent work behind a page.
- Later, `![[…]]` embeds: another page, a section, a cell's output, an
  answer.

### Decisions (after the rest)

Chopin's best idea: decisions are recorded apart from the prose, attributed,
and marked "not rechecked" when the prose they came from changes. In
Chattering's terms: comments in the file (`<!--! … !-->`, which MRMD has),
an accepted comment asks the agent to revise, and the page keeps its
decisions in the file. Not before the steps below.

## Order of work, each step useful alone

0. **Trust first.** Fix the unsanitised HTML (a security bug, not UX).
   Build the editor "jank meter" proposed in 01a0ea38 (type, move, drag
   across tables and maths; measure how far anything moved; target zero) and
   fix what it finds before adding editor features. Sweep dead clicks. Take
   01a0ea39's weak-device findings. *Cost: a pause in visible features.*
1. **One finder.** Biggest daily win for navigation; mostly joins existing
   parts.
2. **The pair.** The editable page beside the conversation — the artifact
   panel's "step 2" done properly: an editor that can live in more than one
   place, and shared editing that does not depend on the full-screen file
   view.
3. **Pages know their conversations.** "Linked here" with conversations;
   a conversation's header names its pages; asking from a page continues
   that page's conversation by default (the ask box already prefers it).
4. **Links.** `[[` → Markdown links, rename-safe, backlinks between pages.
5. **Reading defaults for pages.** A reading face and width for prose by
   default (code stays monospace); read mode on phone and e-ink (design/63
   step 5).
6. **Live agents and runs that outlive the window.** Agents write into the
   shared text with a visible cursor and no lock; cells run on the server
   and every device sees the result (MRMD daemon's "Yjs is the bus",
   design/63 rule 5).
7. **Comments and decisions in the file.**

## A surface budget

The accretion in cause 2 will return unless something stops it:

- Keep one page that maps every place in the app (screen, panel, list) and
  what it is for. Each new design note names the place it lives in, or the
  place it replaces.
- Before removing anything, measure: count route and panel visits locally
  for two weeks (on this machine only, nothing leaves it). Candidates to
  merge or remove once the numbers are in: the Files browser's
  Browse/Changes/Highlight/By controls (Maxime, 01a0b945: "I'm not going
  into file modes much. It's weird"), the right panel's three tabs, and the
  rarely used screens (evidence, epic, usage), which the finder can still
  reach.

## How to know it worked

- The loop from "finished" to reading the answer to being back where you
  were: seconds, not screens.
- Back/Forward between a conversation and a file drops sharply once the
  pair exists.
- Distinct places visited per session goes down; finder use goes up.
- Editor jank: zero pixels on the meter's script.
- The stranger test (design/73) grows one step: write a page, ask the AI
  beside it, run a cell, close the app, and find the page again the next
  day in under five seconds (design/00's own target, applied to pages).

## Trade-offs, said plainly

- **Page-first changes what the product feels like**, from a chat app with
  files to documents with AI beside them. Quick questions with no document
  must stay one key away; loose conversations remain first-class.
- **Derived ties can be noisy** (an agent that edits many files). The rule
  "started from or edited, ranked by how much" needs checking against real
  conversations before it is trusted.
- **Step 0 slows visible progress** for a while.
- **Removing places breaks habits**, Lilly's and Jacob's included; measure
  first, remove second, keep Undo-like escape hatches (the finder reaches
  everything).
- **A reading font by default changes the brand's terminal look.** Chrome
  and code can stay monospace.

## Decisions this needs (Maxime's)

- **U1** — Pages as the unit of thought, conversations as traces beside
  them: yes or no? *Recommend yes;* it is design/41's rule at product scale.
- **U2** — Step 0 before new features in the editor? *Recommend yes;* the
  security bug alone justifies it.
- **U3** — The finder's key. Ctrl+K is the file's Ask box; Obsidian uses
  Ctrl+O (switcher) and Ctrl+P (commands); VS Code uses Ctrl+P with `>` for
  commands. *Recommend Ctrl+P, with `>` for commands.*
- **U4** — Reading face as the default for prose pages? *Recommend yes,*
  keeping monospace for chrome and code.
- **U5** — Turn on local counting of visits for two weeks before cutting
  places? *Recommend yes.*
