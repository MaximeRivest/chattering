# 33 — Files mode: the inverted funnel

Status (2026-09-11): superseded — the files lens home, the files landing (README, tree, ridge) and the big file workspace (tree, who-strip, Live/History modes, vouch/dispute) are gone. What remains: the files browser (design/35), the live editor with History and Ask (design/37), and the change review (design/36).

Status: implemented 2026-09-08 (commit after `aec2240`); the notes at the
end record where the build departed from this text. Date: 2026-09-08.

## 1. Purpose

Today Chattering is conversation-first. Home is a Gantt of conversations, a
project opens its memory, a conversation opens files as a side trip, and
every side trip returns to the conversation. That funnel is finished and
works.

Files mode is the same app with the funnel turned around:

| | conversations mode (today) | files mode (this design) |
|---|---|---|
| home rows | conversations, grouped by project | **files**, grouped by project |
| a mark | one conversation: span + message density | one **edit session** on one file: span + change magnitude |
| project click | memory overview, TOC on the left | **README** in the editor, **file tree** on the left |
| leaf view | transcript | **the file**: MRMD for markdown, a code editor for the rest |
| side trip | conversation → file → back | **file → conversation (that edited this file / line) → back** |
| composer | send to the agent in this conversation | **ask for a change to this file**; context assembled from the file, cursor, recent edits, project memory |

Both modes share every view below the funnel. Nothing is duplicated; only the
entry, the grouping, and the back target change.

## 2. What already exists (reuse, do not rebuild)

The file side of Chattering is already deep. The implementer must build on
these, not beside them.

**Data and truth**

- `conversationDiffs(key)` (server) mines every edit / write / shell mutation
  from a transcript, cached per transcript version. Truth levels attempted /
  applied / committed are kept apart (`design/18`).
- `projectFileHistoryResponse` weaves AI events, Git commits, working tree,
  and 24 h activity per file. Heavy: it re-reads every conversation's diff
  cache per request (3.7 MB full, 40 KB `light=1`).
- `fileHistoryPointsResponse` / `snapshot` / `changes`: keyframes per file
  (`current`, `git:<hash>`, `ai:<eventId>`), exact or replayed snapshots,
  and interval line history. **Line → conversation already works** through
  `toggleLineHistory` → `showDiffEvent` (`design/19`).
- `fileBlameResponse`: agent-attributed blame by replay (`design/16`).
- `~/notes/chattering/doc-edits.jsonl`: durable provenance of editor saves
  (actor human/ai, input keyboard/voice/pen, ±lines, sha).
- `~/.cache/chattering/project-file-activity.json` + `fs.watch` per repository
  root: a **24-hour rolling** activity index. It forgets after a day and only
  starts watching a repository after someone opened its code surface.
- The trust ledger (vouch / dispute, line-anchored) labels file content.

**Surfaces**

- Project switch `overview | documents | code` (`projectSwitchHtml`).
  `documents` = list + MRMD editor. `code` = repo tree + focused file compare
  with two draggable keyframes (`enterFocusedFile`, `loadFocusedFile`,
  `renderFocusedTimeline`, `createCompareList`, the virtualised diff).
- The MRMD document editor (`mountDocumentEditor`): autosave after 2 s with a
  SHA conflict check, `save revision` = one-file Git commit with an AI title,
  `reload from disk`, code cells via rat, `unwrap lines`. The bundle exposes
  the CodeMirror 6 `view`, so cursor and selection are readable.
- Code editing today is a `textarea` with a paint-behind highlighter
  (`codeEditHtml` / `wireCodeEdit`), explicit save through `/api/file/save`.
- Home Gantt machinery: `timelineGrid`, `markGeom`, `violinPath`, project
  rows, zoom, rubber-band, `svgTagFor` windowing, cluster collapse, the
  `miniGanttHtml` project masthead.
- Router: `setRoute` / `dispatchHash`, one hash per view, breadcrumb spine,
  "the app never navigates by itself" (`design/22`).

**Sending context to an agent**

- `/api/project/context` builds the reviewed bundle; `/api/project/start`
  puts it in the system prompt (`--append-system-prompt`) and opens a warm
  RPC session; `startReviewedConversation` shows the "review the context
  before it goes" card.
- Attached-context chips (`@` palette, `normalizeContextItems`,
  `/api/conversation/attached-context`) ride in the system prompt of every
  later send. Item kinds today: memory documents and chats.
- `/api/git/file-feedback` (ink send) already starts a new session from a
  file page with compare points + project briefing: the precedent for
  "prompt a change from a file".
- Run cards stream headless progress into a conversation (`renderRunCards`,
  SSE `run-event`).

## 3. The model

### 3.1 One app, two lenses

The mode is a top-level **lens**: `conversations | files`. It is one
persisted value (`localStorage Chattering.lens`), expressed in the hash for the
two views it changes (home and project), and shown as one control in the top
bar next to the brand button: `⌂` `[conversations ⇄ files]`. One key toggles
it (pick a free key; `f` is taken by filters).

The lens changes exactly three things:

1. **What home shows.** Conversation rows or file rows.
2. **What a project click opens.** Memory overview or README + tree.
3. **What "back" and the breadcrumb root mean** inside shared views.

Everything else is shared. A conversation opened from files mode is the
ordinary conversation view. A file opened from conversations mode is the
ordinary file workspace. This is the rule that keeps the addition from
forking the app.

### 3.2 Levels in files mode

```
home (files Gantt: project rows · file rows · edit-session marks)
 ├─ project ── README in the editor · file tree left · project file ridgeline on top
 │    └─ file workspace ── write (editor at "now")  ⇄  history (two keyframes, compare)
 │          ├─ who touched this file → conversation at that edit (shared view)
 │          ├─ line → conversation at that tool call (exists)
 │          └─ ask for a change → run card → file reloads live
 ├─ conversation (shared) ── diffs ── file workspace
 └─ settings
```

Every click lowers one level, as before.

### 3.3 The temporal unit: an edit session

Conversations are spans with message density. File edits are points of
different natures:

| producer | shape | magnitude known |
|---|---|---|
| human typing in the MRMD editor | a stream of autosaves every ≥2 s | chars and lines |
| an agent's edit / write tool calls | a burst of instants inside one conversation | chars (old/new text) and lines |
| a Git commit | one instant | lines (numstat) |
| an external write seen by `fs.watch` | one instant, actor unknown | lines (from the last known snapshot) |

To make them "roughly the same" as conversations, the ledger groups events
into **edit sessions** per file:

- **AI session** = all edits one conversation made to one file. Span = first
  to last edit. This makes one AI mark on a file row correspond exactly to
  (conversation × file): the mark's title is the conversation title, and a
  click opens that conversation at its first edit of the file. In
  conversations mode the same pair is one row of that conversation's `diffs`
  view. The two lenses are inverses of one relation.
- **Human session** = editor saves on one file with gaps ≤ 10 min.
- **External session** = watch events with gaps ≤ 10 min and no AI event or
  editor save within ±3 s of them (those are the same change seen twice).
- **Commit** = a diamond on the row, never merged into a session.

A mark's x-extent is the session span (minimum width as for short
conversations). Its **thickness is the violin profile of change magnitude
per time bin** (chars when known, else lines × 40 and labelled "≈"). Colour
is the project, as everywhere. Actor is a **shape**, so e-ink stays honest:
solid violin = human, hatched violin = agent, hollow = external, diamond =
commit.

## 4. The file edit ledger (the one real architectural addition)

Home in files mode must answer "which files changed, when, how much, by
whom, across every project" in milliseconds and stay true for months. None
of today's stores does that: AI events are re-mined per request, the
activity index forgets after 24 h, editor saves live in a JSONL nobody
queries, Git is walked per repository per request.

### 4.1 Store

`~/.cache/chattering/files.db` (`node:sqlite`, same pattern as `search.db` and
`usage.db`; derived, deletable, rebuilt on boot when missing).

```sql
file_events (
  id            TEXT PRIMARY KEY,   -- stable per producer (see below)
  ts            INTEGER,            -- ms
  path          TEXT,               -- absolute, resolved
  repo_root     TEXT,               -- '' when not in Git
  project       TEXT,               -- canonical project name (folds applied)
  producer      TEXT,               -- ai-edit | ai-write | ai-shell | editor-save | editor-commit | git-commit | watch
  actor         TEXT,               -- ai | human | external | git
  outcome       TEXT,               -- attempted | applied | failed
  added, removed INTEGER,           -- lines
  chars         INTEGER NULL,       -- |newText| - |oldText| magnitude when known
  sha_after     TEXT NULL,
  conv_key      TEXT NULL, entry_id TEXT NULL, call_id TEXT NULL,
  commit_hash   TEXT NULL,
  input         TEXT NULL,          -- keyboard | voice | pen | ai-edit | filesystem
  src_version   TEXT                -- transcript mtime:size / refs signature, for invalidation
);
index (path, ts); index (project, ts); index (conv_key); index (repo_root, commit_hash)
```

Event ids: `ai:<existing diff event id>`, `doc:<ts>:<rand>` (already
generated), `git:<hash>:<relpath>`, `watch:<ts>:<rand>`. Idempotent upserts.

### 4.2 Producers (all incremental, none on request)

1. **Transcript indexer.** When a conversation is indexed or re-indexed
   (`reindexIfChanged`, the existing watcher), run `conversationDiffs(key)`
   (already cached) and upsert its events; delete rows of that `conv_key`
   whose `src_version` is stale. Cold start: one backfill job over the
   index, visible in Jobs.
2. **Git.** Per registered repository, ingest `git log --numstat
   --find-renames` since the last seen tip per ref; re-check when the refs
   signature changes (the signature `loadGitRepository` already computes).
3. **Editor saves and commits.** `docSaveResponse`, `fileSaveResponse`,
   `docCommitResponse` write the ledger directly (they already write
   `doc-edits.jsonl`; keep that file as the human-readable provenance log,
   the ledger is the query index).
4. **fs.watch.** Start watchers **at boot** for every registered project's
   repositories, not on first visit. Dedupe against 1 and 3 within ±3 s on
   the same path; the rest is `actor = external`. Never label a watch event
   "human" — unknown is unknown.

`project-file-activity.json` becomes redundant and is removed once the code
tree badges read from the ledger. `projectFileHistoryResponse` should also
read AI events from the ledger instead of re-mining; that is a later
optimisation, not a prerequisite.

### 4.3 Queries

```
GET /api/files/timeline?from=<ms>&to=<ms>[&project=][&kind=docs|code|all][&actor=]
  → { projects:[{ project, rows:[{ path, repoRoot, rel, sessions:[{ id, actor, start, end,
      bins:[…], added, removed, chars, approx, convKey?, title?, n }], commits:[{ ts, hash, subject }] }],
      more: <files hidden by the per-project cap> }] }
GET /api/files/touched?path=<abs>            → sessions and commits for one file, newest first
GET /api/files/project-ridge?name=<project>   → sessions of the whole project, coarse bins (masthead)
```

Window-bounded, row-capped per project by activity in the window (as the
home Gantt caps and clusters conversations), sorted by latest activity.

### 4.4 Live

New SSE event `file-activity { path, project, ts, actor, producer }` on every
ledger insert (debounced per path at 250 ms). Consumers only patch data:
the home files Gantt adds or grows a mark, the file workspace reloads a
clean editor or raises the disk-changed banner, the tree badge updates. No
navigation, per `design/22`.

## 5. Screens

### 5.1 Home, files lens

Same tray as today: tabs, Gantt toolbar, zoom, project filter, rubber-band.
Tabs in files mode: `files · documents · code · repos` where documents /
code are kind filters of the same chart (markdown and notebooks vs the rest)
and repos is the existing tab. `notes` and `epics` stay in the conversations
lens; their glyphs still paint on project rows here because a note is a
file too.

Rows: project rows as now; inside a project, one lane per file, top N by
activity in the visible window, then one quiet `+K more files` label that
opens the project. File labels in the left gutter: `dir/…/name.ext`, the
directory dim. Hover: full path, sessions count, last actor.

Marks: edit-session violins and commit diamonds (§3.3). Click: a human or
external session opens the **file workspace** at that session's last save;
an AI session opens the file workspace with the two keyframes set around
that session (before its first edit → after its last) — the conversation is
one click further, in the "who touched this" strip. Shift-click on an AI
mark opens the conversation directly. Diamond click opens the commit patch
(exists).

Selection: rubber-band selects files; the selection bar offers `ask for a
change across these files` (same composer as §5.4, several paths in the
bundle) and `compare` when two marks of one file are selected.

Phone: cards of recently edited files by project, as the phone conversation
home does; the desktop Gantt is not shrunk.

### 5.2 Project, files lens (`#files&project=<name>`)

```
[project file ridgeline masthead — sessions of every file, collapsed ≤ 20 vh, click to expand]
<project title>                                   [+ ask for a change]  [memory ▸]
┌ file tree (filter, kind badges, activity in window) ┬ README.md in the MRMD editor ┐
│  documents/                                          │ (editable: autosave · save revision) │
│  src/                                                │                                       │
│  README.md  ●                                        │                                       │
└──────────────────────────────────────────────────────┴───────────────────────────────────────┘
```

- The masthead reuses the `miniGanttHtml` / `mgPaint` component with file
  sessions as items (needs a data adapter, not a new chart).
- The body is the repository README (`README.md`, else `readme.md`, else the
  first markdown at the root). No README → an empty state with one action:
  `create README.md` (through `docCreateResponse` at the root, not in
  `documents/`). Agents and humans both find a README instantly, which is
  why it is the landing page rather than the generated memory.
- The tree is `fileTreeHtml` with its window statistics (`updateFocusedTreeWindow`),
  plus a kind filter `all | docs | code`. Click a file → file workspace, the
  breadcrumb comes back here.
- `memory ▸` opens the ordinary project overview (conversations lens view)
  without switching the lens. Areas keep working: a file inside a declared
  area shows the area chip in the head; "ask for a change" starts in the
  area.
- **Consolidation:** the `documents` and `code` project surfaces are early
  forms of this frame. Once this lands they redirect
  (`project=…&docs` → `#files&project=…`, `&doc=` → `#file=`, `&tree` →
  `#files&project=…`). Three frames become one.

### 5.3 File workspace (`#file=<abs path>[&line=N][&from=<point>&to=<point>]`)

Lens-agnostic. The frame is today's focused file (tree left, one file's time
track above, body centre) with **two bodies under one time track**:

- **write** — the editor at `current`. Markdown (and `.qmd`, `.Rmd`,
  notebooks-as-markdown): the MRMD editor as it is on the documents surface.
  Everything else: a CodeMirror 6 code editor **from the same vendored
  bundle** (`createCodeEditor` added to `mrmd-editor`'s document entry,
  vendored as 0.10). One editor engine, one theme object (`mrmdHostTheme`),
  one cursor API. The textarea overlay (`wireCodeEdit`) is retired.
- **history** — the existing two-keyframe compare, line history, reading
  mode, ink, trust buttons, untouched.

The time track is the single control: the `new` key at `current` means
write; dragging either key away flips to history; `▸ now` returns to write.
Nothing else switches modes. Session violins (from the ledger) paint on the
track behind the point marks, so the track is a tiny per-file Gantt, not
only dots.

Head bar: `← back` (target from lens and origin, remembered like
`conversationFileReturn`), path, status line, `who touched this` strip:
up to six chips newest first — conversation titles for AI sessions (`click:
open at its first edit of this file`), `you · keyboard · 3 sessions`,
`external · 2`, `N commits`. Then the editor actions (source, unwrap, run
cell, save revision) and the trust buttons.

Gutter (write mode): line numbers; ✓ / ✗ trust marks as today; on hover a
quiet provenance hint from agent blame ("agent · Docs UI · 2 Sep") with a
click → conversation at that call. Blame is a replay; the hint says
"attributed", never "exact".

Saving:

- Markdown: autosave after 2 s + `save revision`, as today.
- Code: **explicit save only** (`Ctrl+S` → `/api/file/save` with the base
  SHA), `save revision` commits when inside Git. Trade-off, stated: autosave
  is the right feel for prose and wrong for code — build watchers, test
  runners and agents read files the moment they change, and a half-typed
  line is not a state anyone wants observed. The status line says which
  policy is active. A per-project setting can turn code autosave on later.
- Disk changed while open (watch → SSE): clean editor → reload silently and
  mark the changed lines in the gutter for one minute; dirty editor → banner
  `changed on disk by <actor> · reload · keep mine · see diff`, no silent
  merge, no lost text.

Cursor memory: last cursor and scroll per path in `localStorage`, restored
on reopen. Cheap and it makes "come back to the file" feel continuous.

Keyboard: `e` focus editor, `h` history, `n` now, `[ ]` previous / next
session on the track, `c` open the newest conversation that touched the
file, `?` help as everywhere.

### 5.4 Ask for a change (the composer under the file)

The point of files mode is the loop: read → ask → watch the file change →
read. The composer is docked under the editor, collapsed to one line
(`ask for a change to this file…`), and it **is the conversation
composer**, not a new textarea: snippets (`;;`), `@` chips, models,
dictation, images all work. This requires extracting the composer from its
conversation-only wiring (`activeRel`, `#agentText`) into a component that
takes a target. That refactor is the main cost of this section and is worth
it: two composers would drift within a month.

**Target.** A chip shows where the prompt goes and can be flipped:

- default: `↳ continues "<title>" · 2 h ago` when a conversation of this
  project touched this file in the last 6 h, is not owned by a terminal, and
  is not a delegation worker;
- else `↳ new conversation in <project>[/<area>]`, rooted at the project
  (or declared area) like `startReviewedConversation`.

**Context.** A new attached-context item kind `{ type:'file', path, range? }`
joins `normalizeContextItems` and the `@` palette (`@` already lists memory
and chats; it gains `file`). The server renders it in the bundle as:

1. the file: whole text with line numbers when ≤ 64 KB, else the selection
   ±200 lines and a note that it is a window;
2. the selection or cursor line(s), quoted with numbers — read from
   `editor.view.state.selection` at send time;
3. recent edits to this file from the ledger (last five sessions: when,
   actor, ±lines, conversation title);
4. the neighbourhood: other files touched in those sessions (top five);
5. the project map (`include.map`, trimmed as `/api/project/context` does);
6. one instruction: edit the file in place with tools, do not rewrite
   unrelated parts, the user is watching this file live.

`review the context before it goes` stays available as a disclosure, one
click, default closed — same honesty, less friction.

**Send.** Headless RPC (`/api/node/send` path, never the terminal bridge;
parallel model sets allowed). The file item persists as a chip in that
conversation, so later sends from the transcript keep the file in context.

**Watch.** The run card renders under the composer (same component and SSE
feed as in conversations). While a run is active on the target
conversation, the editor is **read-only with a banner** (`agent working ·
your turn when it settles · stop`). Trade-off, stated: this blocks typing
for the run's duration, but the alternative is an autosave racing an agent
write, which the SHA guard turns into "your keystrokes were dropped". On
settle: reload, gutter-mark the lines changed since the pre-send SHA, status
`agent changed +12 −3 · history · open conversation`. The view does not
navigate away.

## 6. Routes and the breadcrumb

Hash grammar additions:

```
files                          home, files lens
files&project=<name>           project landing (README + tree)
file=<abs>[&line=N][&from=&to=][&back=<hash>]   file workspace, lens-agnostic
```

`dispatchHash` for `''` (home) and `project=` reads the persisted lens:
`#project=x` in files lens opens the README landing; the reverse for
`#files&project=x` is not needed (explicit hashes always win). The toggle
control rewrites the current home / project hash and re-renders in place.

Breadcrumb: `❯ files ▸ Chattering ▸ server.js` in files lens; a conversation
opened from a file shows `❯ files ▸ Chattering ▸ server.js ▸ Docs UI`, and its
`←` returns to the file at the same keyframes and cursor. In conversations
lens the root reads `home`, as today. The existing `#doc=`, `filecall=`,
`blame=`, `git=` routes keep working; `doc=` becomes an alias of `file=`.

## 7. Truth and trust rules (carried over, not optional)

- Attempted, applied, committed stay separate (`design/18`). A failed tool
  call is a hollow mark and never joins a session's magnitude.
- Replayed AI snapshots and blame say so. Git and disk snapshots are exact.
- Watch events without a matching producer are `external`, never "you".
- Magnitude shown as `≈` when it is lines × 40, never as characters.
- Trust labels appear in the editor gutter and in the bundle sent to the
  agent (`[vouched DATE]`, `[disputed]`), as briefings already do.

## 8. Phases

Each phase ships on its own and is useful alone.

0. **Ledger.** `files.db`, four producers, boot watchers, backfill job,
   `/api/files/*`, SSE `file-activity`, tests on the session grouping and
   the dedupe window. No visible change except faster code-tree badges.
1. **Lens + home + project landing.** Toggle, `#files`, files Gantt with
   sessions and diamonds, README landing with tree and masthead, redirects
   from the `documents` / `code` surfaces.
2. **File workspace.** One time track, write ⇄ history, `createCodeEditor`
   in the vendored bundle, retire the textarea overlay, "who touched this"
   strip, blame hints, cursor memory, disk-change policy.
3. **Ask for a change.** Composer extraction, the `file` context item,
   target chip, run card under the editor, read-only-while-running, settle
   diff marks. Multi-file ask from the home selection.
4. **Polish.** Phone cards, e-ink shapes, keyboard help, a per-project code
   autosave setting, rename following (`--find-renames` rows keep identity).

## 9. Trade-offs made here, so they are not absorbed silently

- **A new SQLite store** instead of extending the JSON caches. Reason: the
  home query is a range query over every project; JSON caches are per
  project and per day. Cost: one more derived database and a backfill job.
- **Watchers at boot** for every registered repository. Cost: inotify
  watches on large trees; mitigated by the existing `.git` exclusion and by
  honouring `CHATTERING_NO_WATCH` if a machine hits the limit. Without this
  the home chart would be blind to edits made outside Chattering.
- **Code does not autosave.** Stated in §5.3.
- **Editor locked while an agent run is active.** Stated in §5.4.
- **One editor engine.** Adding a code entry to the vendored MRMD bundle is
  cross-repository work (`mrmd-packages/mrmd-editor`), and the bundle grows.
  The alternative — keeping the textarea overlay — means two cursor models,
  two theme paths, and no shared selection API for the composer.
- **Composer extraction** before the file composer exists. Slower to the
  first demo, the only way to keep one composer.
- **The `documents` and `code` surfaces are folded in**, not kept beside
  the new frame. Fewer frames; some muscle memory changes.
- **AI mark = conversation × file.** A conversation that edited one file in
  two bursts hours apart is still one mark. Simpler to read and it mirrors
  the `diffs` view exactly; a `split long sessions` option can come later if
  the marks get too wide.

## 10. Open decisions for the owner

1. The toggle key and the exact label (`files` vs `docs`; this document
   says files, since code and prose share the frame).
2. The session gap (10 min proposed) and the per-project row cap at home.
3. Whether `notes` (under `~/notes/chattering`) appear as file rows in files
   mode or stay only as glyphs. Proposed: glyphs only, they have their own
   lens.
4. Whether the multi-file ask (§5.1) ships in phase 3 or waits.

## 11. As built (2026-09-08)

- Files: `fileledger.js` (+ tests), `filesmode.js` (client), hooks in
  `app.html` and `server.js`, vendored `mrmd-document` 0.10.0 with
  `createCodeEditor`.
- Home asks for the last 90 days (§4.3 said window-bounded; the default
  is 90 days, cached per project on the project's own write counter).
  Rows per project: 12, `+N more` unfolds; 80 with the project filter.
- The project landing IS the file workspace opened on the README, with the
  ridge above the layout (one frame, not two). The ridge is a static strip
  (click a mark → that file); it does not expand like the conversation
  masthead. Trade-off: less to maintain; the file's own track is one click
  away.
- Hash grammar as built: `files`, `files&project=<name>`,
  `file&p=<project>[&landing][&from=&to=]&path=<abs>` (path last) and the
  short `file=<abs>`; `doc=` and `project=…&docs|&tree` redirect.
- The composer under the file is a dedicated box (§5.4 wanted the
  conversation composer extracted). It sends through `/api/files/ask`
  (target pick + `file` context item + `startAgentRun`), locks the editor
  during the run, reloads and marks lines on settle. Snippets, `@`, and
  dictation are not in it yet; the extraction is the next step.
- Multi-file ask from the home selection (§5.1) is not built; rubber-band
  selection is off in the files chart.
- `notes` stay in the conversations lens (decision 3, proposed answer).
- The textarea overlay editor, `showProjectDocuments`, `showProjectTree`
  are gone; `openFocusedFileEditor` and the quick-file `edit file` route to
  the workspace.
- Memory: the boot ingest evicts the diff-cache rows and Git histories it
  loaded (they live on disk); watched snapshots are bounded at 48 MB, and a
  watcher whose baseline is gone diffs against the committed blob or
  records an unknown (zero) delta — never "the whole file was added".
  Repository watchers walk directories themselves, skipping node_modules,
  build trees, and the like, capped at 2500 directories per repository
  (partial watching beyond that). Measured on this machine: 42 repositories,
  17k directories, ~130 MB RSS after boot (was 1.1 GB with Node's recursive
  watch). `GET /api/files/stats` reports rows, watchers, and memory.
- `CHATTERING_NO_LEDGER=1` disables the ledger and files mode data paths;
  `CHATTERING_CACHE_DIR` relocates every derived cache.

## 12. The ask box (2026-09-23)

The dedicated box under the file became a small composer floating over the
text (`ask-bubble.js`, `ask-bubble.css`): Ctrl+K, the ✦ Ask button, or a
brief handed over (the notebook doctor, "Ask an agent" in the AI command
box) open it just above the cursor's line — below it when there is no room,
a bottom sheet on a phone. It borrows the composer's classes and controls:
dictation (`wireAgentSpeech(ta, mic, grow)` now takes its box), images,
the model picker and the reasoning picker. Model and level are remembered
for the next ask (`chattering.ask.v1`); "default" keeps the target's own.

- Where it goes: the conversation of the last ask comes first, then the
  recent conversations that touched the file, then a new one (only when the
  project has a folder).
- What goes along, as switchable chips: the file and selection (always; the
  selected characters too, not only their lines), the recent edits of the
  file, the earlier asks on it (those of other conversations: the target's
  own are in its history), and the project memory for a new conversation
  (off by default — a file edit rarely needs it and it costs seconds).
  "What goes along" shows the exact text (`/api/files/ask-preview`).
- `file-ask.js` writes the brief that rides last in the system prompt, per
  run and never saved with the conversation's context (`startAgentRun`
  `brief`): the request is about this file; work from the inlined copy;
  edit in place, minimally; stay in the file; the editor is read-only and
  reloads; answer in a sentence or two. For a rat notebook: the exact
  `rat run --doc`, `rat look --doc` and `rat ensure` commands, never hand-
  write a result block, never `pip install`. Recent edits come as diffs
  from the saved versions (sessions of the ledger in the last 24 h, three at
  most); earlier asks from `file-asks.json` with what came of each.
- `startAgentRun` gained `thinking`: set by pi right before the prompt, in
  the same process (no second warm start). A new conversation's first
  process loads the very bundle the run sends.
- Plain by default (2026-09-29): people who barely code saw a wall of
  controls (a target list, review switch, chips, model, reasoning, earlier
  asks, a run line reading "tool · read"). The box now opens with the text,
  the microphone, one line saying whether changes wait for approval,
  "options" and send; the rest is behind "options", remembered per device
  (`more` in `chattering.ask.v1`). The options button's tooltip names the
  current target, model, reasoning and review choice, so none acts unseen;
  Alt+M and Shift+Tab open the options before their picker. The run and its
  result speak plainly ("reading the file…", "✓ done · changed +5 −8
  lines", "details", "stop"), the raw line in the tooltip; with options,
  the technical lines as before. A disabled primary button (everywhere) now
  keeps a readable word instead of white on white.
- The ask routes check the person: the file must be theirs to see / act
  on, the continued conversation theirs to act on, and the run is theirs
  (a guest runs behind the walls). Before, a guest's ask ran as the owner.

## 13. Reviewing AI changes, and keeping what became of them (2026-09-23)

Two ways for AI changes to arrive, chosen per box and remembered per device:

- **Ctrl+K (ask box)**: "✓ review" (default) or "apply". In review mode the
  editor's review (mrmd-document 0.19, `editor.review.capture`) captures
  everything the run changes in the text; at settle the file reloads by the
  smallest changes (`updateContent`), the capture ends, the box steps aside
  and the cursor goes to the first change: old lines struck through above
  the new ones, which stay editable, Accept / Reject on each, a panel with
  accept all / reject all (Alt+Y, Alt+N, Alt+Shift+Y/N, Alt+] / Alt+[).
  The agent's text is on disk meanwhile, as when applied directly (the
  pattern of agent editors: the agent's later reads see what it wrote);
  a reject is the person's edit (autosaved for Markdown; a code file asks
  for Save, as code never autosaves).
- **Ctrl+J (AI commands)**: "suggest beside it" (default, Tab accepts) or
  "review in the text", switched in the command box; "Edit in text" moves
  one suggestion into the text.

Every outcome is one JSON line in `~/.local/share/chattering/ai-feedback.jsonl`
(`ai-outcomes.js` in the page, `ai-feedback.js` for the record's shape,
`POST/GET /api/ai-feedback`): for a command, the target and its
surroundings, every answer (alternates included), the one shown, the
decision (accepted, discarded, stopped, stale, replaced, …) and, reviewed,
per region the text before, proposed and kept; the prompt's version (hash
of the catalog and of the command's task). For an ask, the request, the
switches, model and level, the agent's own final answer (from the run),
and the diff applied or the reviewed regions. A dataset for evaluating
models and optimizing the prompts.

Limits: collaborators' edits made while an agent runs on a shared file are
captured with the agent's (the person's own editor is read-only then); an
ask queued into a running turn is applied, not reviewed; a review left
open when the file closes keeps its changes and is recorded as `left`.

## 14. The same AI surface in every text file (2026-09-23)

Every text file the workspace opens now has what Markdown documents have:
Ctrl+J commands with the ✦ beside the line, suggest or review, "Edit in
text", the outcome records, the key help, and (already) the ask box and
review of an ask's changes. mrmd-document 0.20.0 gives the whole-file
editor the `ai` option.

- Surfaces (ai-commands.js `surfaceOf`): a Markdown `document`; a `source`
  file (code, config) with the code commands — "Finish this block"
  (`code-block`) instead of the cell's; plain `text` (.txt, .rst, .tex,
  .org, .adoc, README/LICENSE without extension…) with the prose commands.
  The server refuses a command on a file of another surface; the prompt
  says what the file is ("part of a python file").
- In a source file a command without a selection acts on the outermost
  syntax construct at the cursor that fits 12 000 characters, with the
  comments right above it; in plain text, the paragraph.
- Provenance for code: a shared file saves as you type, as documents do.
  One that is not shared saves only on Save: accepting writes nothing; the
  save that writes exactly the result (within the hour) is recorded as the
  AI's edit — or, when the person's unsaved typing went along, as theirs
  with the AI's part noted (`ai.mixed`). /api/file/save now records AI
  edits in the edit log like /api/doc/save (`claimAiEdit`).
- Notes, epics and project memory (Markdown under ~/notes/chattering) open
  in the file editor ("edit file", a section's "edit" at its line) instead
  of the bare textarea, which bypassed history, AI and review. The
  workspace accepts them (`editableFilePath`, `isNotesDocument`); the old
  /api/notefile/save route is gone. The distill "review the note" box is
  a draft that is not a file yet and stays as it is.
