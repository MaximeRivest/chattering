# 110 · Finding context for a conversation

*2026-11-01. A study of the Context dialog, then its replacement, built the
same day. Modules: `search-worker.js` (searches on a thread of their own;
the index's check and repair), `search-service.js` (the server's side:
writes held during a repair, the start check, a newer search replacing a
waiting one), `searchindex.js` (`searchDb`: snippets cut from the text,
counts capped, the newest ranked for very common words, OR for a draft;
`hold`/`release`; the repair steps), `context-finder.js` (depths, a
draft's words, links, the summaries' store), `context-panel.js` and
`context-finder.css` (the finder, a Beside tab of kind `context`),
`server.js` (`/api/context/find`, `/api/context/source`,
`/api/context/summary`, depths in `normalizeContextItems` and
`writeAttachedContextFile`, `contextSummaryFor`, `projectEntriesByName`),
`app.html` (`contextFinderApi`, chips with depth and size, the budget
line, `contextSendGuard`, settings → summaries of attached conversations),
`ai-programs.js` (`context_summary`), `harness/terminal/chattering-mcp.js`
(`records_search`, `records_show` for Claude Code). Tests:
`context-finder` (pieces, the worker, a repair of a damaged index with a
write made during it), `context-finder-browser` (routes, what each depth
sends, the finder driven by keys). Mockup of the proposal:
`prototypes/finding-context/index.html`.*

## The job

Written down on 2026-09-08 (conversation 01a0834f), still right:

> Bring knowledge from elsewhere into this conversation without
> re-explaining it, and let me check exactly what I am giving the model.

Four steps: **find** the source, **recognise** it is the one meant,
**choose how much** of it, **see the effect** on this conversation. The
2026-09-08 rebuild added the preview (step 2) and a token count (step 4).
Steps 1 and 3 are still weak, and since the 2026-10-31 disk move step 1
is partly broken.

## What it does today, measured (2026-11-01, lambda)

### Broken

1. **The search index is damaged.** Its file was created at 21:47 on
   2026-10-31, while the disk move copied it with the server still writing to it.
   SQLite's own check says the full-text index is malformed (the table it
   is built from checks fine). Searches whose words land on the damaged
   part fail with `database disk image is malformed`: `the` and `co` fail,
   `token` works. The dialog shows "Search unavailable"; nothing is logged.
   The index can be rebuilt from its table in place: 29 s on a copy, after
   which the check passes.
2. **Opening the dialog waits 2.8–5.8 s with a blank list.** It first
   fetches the list of every project (`/api/projects/memory-index`), which
   scans all 3,224 conversations once per project (150 projects) on the
   server's main thread. Nothing says "loading". This is the empty left
   column in the screenshot of 2026-11-01. During those seconds the whole
   server answers nobody else.
3. **Every keystroke blocks the server too.** Search runs synchronous
   SQLite on the main thread: 0.2–0.4 s for a common word, 2–7 s cold,
   and it counts every match (43,000 for `token`) for a total the dialog
   never shows.

### Does not do the job

4. **Nothing shows until you type**, and in Conversations mode not even
   then if you only set the project: a query made of filters alone returns
   nothing. You cannot browse "recent conversations in this project".
5. **You must know where the knowledge lives before searching.** A
   dropdown picks Project memory *or* Conversations. In memory mode the
   box matches project *names* only, never what the memory says.
6. **No other sources**: files, notes and epics are absent (files only
   through the separate inline `@` completion).
7. **Results are noisy and in machine words.** One conversation fills up
   to four rows (three matching exchanges + "recent history") with its
   title repeated; rows read `exchange #141`, `[unverified]`,
   `2026-09-08 → 2026-09-08`, `Recent history (up to approximately 12k
   tokens)`. The matched words are not highlighted (the markers are
   stripped). Nothing says why a result ranks where it does.
8. **The preview shows the model's text, not the reader's**: raw
   assembled Markdown in a box, starting with `# Chattering attached
   context` and a timestamp.
9. **Sizes are shown, never weighed.** Chattering's memory, "All four
   sections", is **309,000 tokens** (its intent section alone 296,000),
   more than most models' whole window. Of the 42 projects with memory,
   8 are over 50,000 tokens and 4 over 100,000. Nothing warns or stops a
   send. New-conversation drafts attach a project's intent section by
   themselves (`draftSyncPurpose`).
10. **"How much" has two settings, both blunt.** One exchange, or the
    *newest* ~12,000 tokens of a conversation, which drops its beginning:
    the problem statement and early decisions. There is no summary. Only
    4 of 3,224 conversations have a distilled note to fall back on.
11. **Slow hands.** Click to preview, then click Add; no arrow keys, no
    Enter to add, no picking several at once. The dialog covers the
    conversation you are gathering context *for*.
12. **Meaning search is off.** The meaning-based search service runs on lambda
    (`chattering-semantic`, healthy, 78,754 of Maxime's passages), but
    `semanticSearch` is false in settings, Chattering's push ledger says 0
    sources synced, and this dialog never asks it anyway (the main search
    and the old `@` popup did).

What people did with it anyway, from `model-preferences.json`: 159
conversations carry attached context: 76 conversations or exchanges, 63
intent sections (45 of them segbench, mostly drafts), 49 whole memories,
22 files.

## What the research says about "more context"

Giving a model more text is not free even when it fits:

- Models use information at the start and end of a long input far better
  than in the middle [1].
- Irrelevant text in the input lowers accuracy, even on easy problems [2].
- Even when the model finds the relevant part perfectly, a longer input alone
  lowers performance [3].
- In retrieval systems, adding more passages first helps, then hurts:
  the extra near-misses mislead the model [4].

So the ultimate form does not make it easy to attach *a lot*. It makes it
easy to attach *the right thing at the right depth*, and shows the cost.

## The ultimate form

### Principles

1. **It starts with an answer.** Opening it (or typing `@`) already lists
   what is probably wanted: sources related to the message being written,
   by meaning, and the recent work in this project. Often you never type.
2. **One box, every source.** Conversations, project memory (by what it
   says, section by section), files, notes and epics in one ranked list.
   Narrowing is chips (`this project`, `last 2 weeks`, `conversations`)
   and typed shortcuts (`p:`, `since:`), never a mode you must pick first.
3. **One row per source, in human words.** Title; project; "3 days ago";
   the passage that matched with the words highlighted; a size badge. A
   conversation with three matching exchanges is one row that says so.
4. **Depth is a choice per source, with its cost on the button.**
   - **Link** (~50 tokens): the title, a one-line gist and the id; the agent
     opens it with its own tools if it needs it. The default for most.
   - **Summary** (~1–2k): written once by a small model, cached, shown in
     the preview before it is used, marked as AI-written.
   - **Excerpt**: the messages or sections you tick in the preview.
   - **Whole**: offered only when it fits the budget.
5. **The preview is a reading view.** Messages as the conversation shows
   them, memory rendered, opened at the matched passage, with ticks to
   build an excerpt. The exact text the model will get is one toggle away.
6. **A budget, not just a number.** A bar under the attached list:
   attached tokens against the chosen model's window, with a recommended
   zone. Anything that would push a send over the window gets its depth
   lowered by default and is flagged. A send never fails silently on size.
7. **It lives beside the conversation, not over it.** `@` in the composer
   opens a palette right above it (fast path: pick, Enter, keep typing).
   "More" expands it into the side panel (design/104) with the preview,
   while the conversation stays readable.
8. **Keyboard all the way.** ↑↓ move, Space preview, Enter add at the
   default depth, Tab changes depth, ⌘/Ctrl-Enter add and close, Esc.
9. **Trust and age at a glance.** "AI-written, not reviewed" as a small
   mark with an explanation on hover; "updated 2 days ago" instead of ISO
   dates; a memory section older than its project's last work says so.

### Speed it must have

| Moment | Target | Today |
|---|---|---|
| Dialog visible with suggestions | < 100 ms | 2.8–5.8 s blank |
| Each keystroke's word matches | < 100 ms | 0.2–7 s, some fail |
| Meaning matches arrive | < 500 ms, streamed in | never |
| Preview of a source | < 100 ms | 2–30 ms ✓ |
| Server busy while searching | never | blocked |

How: search in a worker thread; no full match count; the project list
kept up to date in memory instead of rebuilt per request; suggestions
computed while the person types their message; the meaning stage on and
synced; the index checked at start and rebuilt by itself when damaged.

## Phases

**0. Repair (hours).** Rebuild the full-text index (needs a restart: 30 s
of rebuild, running agents interrupted). Detect "malformed" at query time,
log it and rebuild in the background. Cache the project list; show a
loading state. A filters-only query lists recent conversations. Drop the
full count. Warn on any attachment over 20% of the model's window and on
the 309k-token memory now.

**1. One box (days).** All sources in one ranked list, one row per
source, human labels, highlighted passages, keyboard, side panel instead
of the modal, `@` palette and Context button are the same component.

**2. Depth and budget (days).** Link / Summary / Excerpt / Whole per
source; cached summaries; budget bar; send guard; drafts attach a
project's intent as a link, not inline.

**3. Suggestions (a week).** Meaning search on and kept synced;
suggestions from the draft and open files; "why this" on each.

## Trade-offs, stated

- **Summaries cost model calls and can be wrong.** A small model, once
  per conversation version, cached; the preview shows the summary before
  it is used and labels it AI-written. Excerpt stays for exactness.
- **Links rely on the agent reading records itself.** Pi has
  `chattering_search` / `chattering_show`; Claude Code and Codex have only
  the `chattering` command (their MCP server offers `artifact` and `show`,
  not search), so phase 2 adds `search` and `show` there. An agent that
  cannot read records gets the summary instead of a link, automatically.
- **Meaning search needs the GPU service.** When it is down the list is
  word matches only, as today, and says so.
- **Suggestions read the draft as it is typed**, on this machine only
  (lambda's own service), never sent elsewhere.

## References

- [1] https://doi.org/10.1162/tacl_a_00638 — Liu 2024, TACL ("Lost in the Middle")
- [2] https://doi.org/10.48550/arxiv.2302.00093 — Shi 2023 (GSM-IC)
- [3] https://doi.org/10.48550/arxiv.2510.05381 — Du 2025
- [4] https://doi.org/10.48550/arxiv.2410.05983 — Jin 2024

## What was built, and how it differs from the proposal

Everything in phases 0 to 3, with these decisions taken while building:

- **Repair without a restart, and without losing writes.** The index is
  checked at every start (about 7 s on 800,000 passages, off the server's
  thread; writes wait meanwhile and are applied after). A damaged index is
  rebuilt from its own table in steps (36 s for 800,000), searches saying
  "being repaired (N%)" meanwhile instead of half the answers. If that does
  not cure it, the file is dropped and every conversation indexed again.
- **Very common words** (more than 10,000 matches) rank their newest 2,000
  matches instead of all of them: 14 ms instead of seconds. The answer says
  so ("very common words: newest first, add words to narrow"). A word being
  typed matches as a beginning from 3 letters, not 2: two letters expand to
  thousands of words.
- **Snippets** are cut from the passage's text after the search, not by
  SQLite's `snippet()`, which for a word beginning took 17 s for 90 of them.
- **One component, two ways in.** The finder is a Beside tab; the composer's
  Context button, `@` outside the text box and a click on a chip open it.
  Typing `@` inside the text box still completes a file path into the text
  (a different thing: a reference in the words, not attached context).
- **Default depths.** A conversation under ~4,000 tokens goes whole; larger,
  as a summary. A document within the recommended size goes whole; larger,
  the matched sections, else a link. A file within it goes whole, else a link.
- **Summaries are written when chosen**, not for each depth Tab passes over
  (after a second on Summary, or on adding). A send never waits for one: if
  it is not written yet, a link goes and the person is told.
- **A summary is pinned to the version previewed** (what was read is what is
  sent; the prompt cache stays warm). A conversation that went on says so,
  with "Write it again".
- **Items attached before** keep their exact old behaviour and text (a
  conversation's newest ~12k tokens, or one exchange; memory whole). A new
  conversation's draft attaches a project's purpose as `auto`: whole when
  within the recommended size, a link when it grew past it.
- **The recommended size** is 40,000 tokens, or a fifth of a smaller
  model's window. A design default, not a measured threshold: the research
  shows the trend, not one number. The send guard asks before a send only
  when attached context passes half the window or what the conversation has
  left; the line under the chips warns past the recommended size.
- **Who may do what.** The finder's rows are gated in the handler: the
  conversations, projects and files a person may see; the records' notes and
  epics for those who see all; file names listed as the person (their own
  account: their host). Writing a summary is a model call: not for guests.
