# 66 — One tree, one head

Status (2026-09-23): phase 1 built; phase 2 built except storage (parallel
answers still run in hidden forks and fold home when they finish). Follows
`65-open-webui-study.md`. Replaces the reading/continuation split of
`34-conversation-reading.md`. Backward compatibility is explicitly not a
constraint (Maxime, 2026-09-23); readable history is.

## What is built

- `conversation-tree.js`: the turn model (questions, answer groups, columns
  and versions, question wordings, other divergences, legacy markers), pure
  and shared by server and browser. Tests: `test/conversation-tree.test.js`,
  on structural copies of real conversations (`test/fixtures/trees`, every
  word replaced).
- One head per person, saved on the server (`~/.local/share/chattering/reading.json`,
  `PUT /api/conversation/reading`, returned with `/api/session`) and pushed to
  that person's other screens (SSE `reading`). Sends carry `node` = the head;
  nothing refuses a send for reading another path.
- The reader (`conversation-reader.js`): blocks patched in place when the
  head moves (60–75 ms on a 4 MB conversation, no fetch); answer cards side
  by side with a per-device layout (all · two · one; phones and e-ink always
  one, swipe or arrows); card click, version arrows, swipe = choose.
- Regenerate asks the same question again from its parent (no `Continue.`),
  and streams as a live card beside the answer it re-does. Edited questions
  are asked at the same point. Merge is a typed `chattering-merge` custom
  message under the question; its reply streams as a new card and becomes
  the head. Include-all is on demand only (reintegration no longer writes it).
- Parallel runs stream as the same cards; the card you click is where the
  conversation continues when they land.
- The tree view lights the head's path; clicking a box moves the head.
- A send follows its own message (2026-09-28). Until the run's question is
  saved, the head stays exactly on the point sent from, and the prompt and
  its live answer show right below it. Once the question is saved, the head
  moves onto it. The reading's `follow` (`from`, `since`/`until` on the server
  clock, `prefer`, `jobs`) is saved with the head, so reloads and the
  person's other screens agree. A live run also ends every reader's newest
  path where it continues (`live` stops, never saved). Before this, a send
  released an exact head at once. The stale snapshot then descended into the
  older path, and the stream showed after it until a page refresh.
  Tests: `conversation-tree.test.js`, and `one-tree-app.test.js` (fails on
  the old code).
- Pi 0.87 custom turns: `pisdk-custom.js` prepares them with the SDK's new
  structured prompt options (delegation callbacks were failing on 0.87 too).

## Not built yet

- Parallel answers in one file while they run (phase 2 storage): until then a
  follow-up waits for running parallel answers to finish.
- Artifacts from the path, Clone, the files-on-disk line, worktrees, ratings
  and presets (phases 3–5).

## Why Chattering feels heavier than Open WebUI

Measured and read on 2026-09-23, not guessed:

- **The data is not the problem.** `/api/session` already sends every branch
  (`entryParents` + all messages): 400–770 KB, 6–25 ms on lambda for the six
  most branched recent conversations. The client already holds the tree.
- **Two pointers.** The reader keeps its own leaf (`readerState.leaf`,
  localStorage); the conversation continues from the session file's last
  entry. When they differ, `readerSendAllowed()` refuses to send and the
  composer shows *Reading another path · Continue from here*. "Continue from
  here" is a server write (a `label` entry) followed by a full reload.
  Open WebUI has one pointer, so none of this exists there.
- **Parallel answers are not in the conversation while they run.** Each model
  runs in a hidden forked session file (`startFanOut`). Live answers render
  through a separate ledger (`#liveReplies`, `renderLiveReplyLedger`), then,
  after *all* models finish, `fanoutmerge.js` rewrites the parent file to fold
  the forks back in, and the reader switches to the recorded renderer
  (`captureLiveReplyHandoff`). Until then you cannot follow up
  (*Wait for the parallel answers to finish…*), and afterwards you must choose
  (*Choose an answer, include all answers, or merge them before sending*).
- **Operations are text in messages.** Regenerate sends a fake user turn
  `Continue.` plus an HTML comment marker, so the model sees an extra user
  message and the new answer is not a sibling of the old one. Merge and
  "include all" are likewise user/assistant messages carrying markers that
  `conversation-flow.js` and `fanout.js` recognise by regex.
- **Three derivations of one tree.** `/api/tree` (`sessionTreeFor`, boxes),
  `/api/compare` (`fanout.js` classification) and the client
  (`ConversationFlow.trace/branches`) each rebuild structure their own way.
- **Every switch rebuilds the page.** `renderConv()` replaces `#view` with
  fresh HTML (header, transcript, live area, composer) for any path change.

## The model

### 1. Truth: one Pi session file per conversation, holding every branch

Pi entries already form a tree (`id`, `parentId`), and Pi writes each entry
with `appendFileSync` (checked in pi-coding-agent 0.87.1
`SessionManager._persist`); it rewrites a file only on format migration or an
empty file. So several runs may append to **the same file** at once: each
entry names its own parent. Runs live in separate worker processes (both
engines), so this relies on Linux `O_APPEND`: one `write()` per line is not
interleaved with another on a local disk. Tested on lambda's btrfs
2026-09-23: 8 processes × 1,500 `appendFileSync` lines of 0–1 MB, three
rounds, 36,000 lines, zero torn.

- Parallel answers, regenerations, edits and merges are all **branches in
  the same file, from the first streamed token.** No hidden fork files, no
  reintegration, no sweep at boot.
- **Fork** (path only) and **Clone** (all branches) stay separate files, made
  only on request, and open immediately. Provenance stays in the header.
- Claude Code conversations keep today's rules: readable tree, fork only.

### 2. Operations use Pi's public paths, typed, never text markers

| Operation | How it is written | What the model sees |
|---|---|---|
| send / follow-up | session positioned at the **head**, `prompt(text)` | the path to the head + the new question |
| regenerate | session positioned at the question's parent, `prompt(sameText)` — a sibling user entry with identical text, then its answer | exactly the original context; no `Continue.` |
| N models at once | the same as N regenerations started together, one session per model on the same file | each model sees the same context |
| edit a question | sibling user entry with the new text | the edited question |
| revise ("shorter", "add details", free text) | at the old answer, `sendCustomMessage({customType:'chattering-revise', display:false, …}, {triggerTurn:true})` | old answer + the instruction |
| merge (ours, kept) | at the question, `custom_message` `chattering-merge` with `details.sources`, the picked answers, the instruction; chosen model | question + chosen answers + instruction |
| include all (ours, kept) | `custom_message` `chattering-include` with the answers | question + all answers |

The custom-message path already exists (`pisdk-custom.js`, delegation
callbacks). Pi's own "regenerate" is the same sibling-question pattern
(`navigateTree` to a user message moves the leaf to its parent).

### 3. One turn model, shared by server and client

A single pure module (`conversation-tree.js`, UMD like today's
`conversation-flow.js`) turns entries into **turns**:

- A **question** = the sibling user entries with identical text (+ images)
  under one parent. Different text under one parent = *question versions*
  (‹ 1/2 › on the question, like Open WebUI's edit).
- An **answer** = everything from the assistant's first entry to its last
  (thinking, tool calls, results, text, delegation cards), with model,
  column, status (`streaming`/`done`/`error`/`aborted`), cost, speed, author,
  and files it changed.
- **Columns** = models. Answers of the same model under one question are that
  column's versions (‹ 1/n ›). Merged and include-all replies are their own
  column, labelled with their sources.
- Old markers (`Continue.` regenerate, merge/both bridges) are read by a small
  legacy adapter in this module so existing history still reads cleanly.
  Nothing new is ever written with them.

The server uses it for records, search, memory and the tree endpoint; the
client uses it for everything on screen. `fanout.js`, `fanoutmerge.js`,
`/api/compare`, `sessionTreeFor`'s box contraction and most of
`conversation-flow.js` go away.

### 4. One head per person per conversation

**What you see is what continues.** The head is the last turn of the visible
path; everything is derived from it:

- the transcript (path root → head),
- what the next message continues from (sent as `parent: head`; the server
  positions the session there — no `label` write, no "advanced on another
  screen" refusal: sending under a turn that gained children just adds a
  sibling),
- the highlighted card in each group, the lit path in the tree map,
- the artifact panel, the context meter, the cost of the path.

Moving the head is purely local and instant: ‹ › arrows, clicking a card,
clicking a tree node, a search hit. Going to another sibling descends to the
turn you last read below it (Chattering's remembered routes, kept), else the
newest. The head is saved per person on the server (small sidecar), so the
laptop and the phone agree; another person's sends never move yours.

When N answers start, your head moves to the first column; clicking another
card is the choice. No blocking at any point.

### 5. Rendering: one renderer, patched, never rebuilt

- A client store `{entries, turns, children, head}` built once from
  `/api/session`, then **patched by appended entries over the WebSocket**
  (streaming text updates the answer in place). Live and saved answers are
  the same component; the live ledger and its handoff go away.
- The transcript is a list of turn blocks keyed by turn id, with rendered
  Markdown cached per answer. A head change re-renders only from the first
  differing turn down; the header and composer are never rebuilt.
- A multi-answer turn renders as Open WebUI-style **equal cards**, streaming
  side by side, selected one solid, others quiet; phone and e-ink show one
  full-width card with column tabs. Merge / include-all / compare sit on the
  group; the merge dialog is ours (pick sources, model, instruction), and the
  merged reply streams into the group as its own card and becomes the head.

### 6. Artifacts that follow the path

Derived from the head path, nothing stored:

- HTML/CSS/JS and SVG code blocks in answers (Open WebUI's rule), and
- **files the agent wrote on this path**, rendered from the checkpoint
  snapshot taken at that turn (`checkpoint-store.js` already captures the
  tree before/after each writing tool call). A multi-file site therefore
  previews *as it was on this branch*, even when the disk holds another
  branch's version. Open WebUI cannot do this.

Rendered with the hardened preview (`html-preview.js`: DOMPurify, opaque
iframe, CSP). "Version n of m" = artifacts on the path; switching branch
switches versions.

### 7. The tree map

The same store drawn as a graph (delegations as dashed nodes, as today).
Clicking a node sets the head. It is a map, not a second editor.

### 8. Files on disk (the part Open WebUI never faces)

A Chattering answer may have changed files. Moving the head does not move the
disk. Instead of blocking, the composer shows a quiet line when the head path's
last checkpoint differs from the disk for the files that path touched:
*Files on disk come from another path (Claude, 14:02) · view differences ·
put this path's files back*. Sending is always allowed.

Parallel answers that **write** files share one working directory today, and
still would. The correct fix is one git worktree per column for writing runs,
with "use this answer's changes" as an explicit apply. That is a separate step
(phase 4), stated here so the head model does not pretend otherwise.

## What we keep from Chattering

Merge dialog (sources, model, instruction) and include-all · remembered routes
· work packages (tool calls folded into the answer) · delegation cards and
dashed tree nodes · fork provenance and the ⤔ mark · per-answer cost and speed
· phone and e-ink single-column layouts · Claude Code reading and forking.

## What goes away

Reading/continuation split, destination notice and the three send refusals ·
"choose before follow-up" · hidden fan-out forks, reintegration, orphan sweep
· `Continue.` regenerate and HTML-comment transport markers (write side) ·
continuation `label` anchors · `expectedLeaf` refusals · `/api/compare` and
the duplicate tree derivations · full-page re-render on path change · the live
reply ledger and its handoff.

## Risks and trade-offs

- **Several sessions on one file.** Relies on `O_APPEND` single-write
  atomicity on a local Linux disk (tested, see §1). Not safe on network file
  systems; session folders must stay local. `pisdk.js` refuses a second worker
  per file today (*Pi session already has a worker*) and must key workers by
  run; a warm worker is reused only if nobody else appended since its last
  write, otherwise it reloads.
- **Duplicate question entries.** Regenerations and parallel runs write the
  question once per answer (Pi's own pattern). The turn model groups them;
  Pi's terminal `/tree` shows them as separate identical questions.
- **Pi version coupling.** Relies on `prompt`, `sendCustomMessage`,
  `SessionManager.branch` and append-only persistence. Pin the Pi version and
  keep an adapter test like `pisdk-custom.js` has.
- **Pi terminal on a branched file** resumes at the last written entry, i.e.
  the branch that finished last. Acceptable; the web app always sends an
  explicit parent.
- **Records and memory** read one file with every alternative. The turn model
  marks alternatives so distillation can read the head path first.

## Phases

1. **Turn model + head + patched renderer.** `conversation-tree.js` with
   golden tests on real branched sessions (including old fan-out merges and
   markers); client store; head replaces reader leaf + file leaf; sends carry
   `parent`; blocking and destination notice removed; one renderer for live
   and saved. *Biggest change in feel, no storage change.*
2. **Parallel and regenerate in one file.** Multi-session runs on one file;
   regenerate and revise without fake prompts; cards with per-column ‹ 1/n ›;
   merge and include-all into the group. Delete fan-out forks and
   reintegration.
3. **Artifacts from the path** (code blocks, then files via checkpoints),
   **tree map on the store**, **Clone** next to Fork.
4. **Files per branch:** the on-disk indicator and restore; worktrees for
   parallel writing runs.
5. **Ratings and presets** (`65` §7–8) on top: 👍/👎 with sibling context,
   an Elo view, modes picked like models.
