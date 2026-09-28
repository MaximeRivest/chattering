# 74 — AI programs in Chattering

Status: the proposal (2026-09-26, below the line) and, first, what was built
on 2026-09-27 (phase 1: see and judge) and 2026-09-28 (live). Making
programs in Chattering and their addresses: design/75. The proposal
extends the Program Atlas mockup (`design/program-atlas.html`, fictional
data).

## As built (2026-09-27)

FunctAI settled the run record itself before this was built: **the call log**
(functai `contract/calls.md`, format 1). Every call of an AI function or a
module is one line of JSON in a folder, one file per writing process and UTC
day; people's ratings are lines in the same folder; Python and TypeScript
write and read the same folder and compute the same rows with known answers
(`rated`). So Chattering adds no record format and no database of its own
truth. It reads that folder, and writes its ratings into it as one more
writer.

- **The folder.** `platform.functaiCallsDir()`: FunctAI's own rule —
  `$FUNCTAI_LOG_CALLS` when it names a folder, else
  `$XDG_DATA_HOME/functai/calls` (`~/.local/share/functai/calls`),
  `~/Library/Application Support/functai/calls` on macOS,
  `%LOCALAPPDATA%\functai\calls` on Windows.
- **The index** (`programs.js`): SQLite in the cache
  (`~/.cache/chattering/programs.db`). One row per call (program, version,
  signature, times, tokens, error, caller, short previews, the answer's JSON,
  and the byte range of its line) and per rating; each call's standing
  (right, wrong, disputed, wrong-with-no-answer). Files are read from the byte
  where the last read stopped; a partial last line (a writer mid-write) waits
  for the next read. Quick reads look at the last two days, a full one every
  five minutes. The whole record is read back from its line only when a person
  opens a call. Delete the index and the next read rebuilds it: ratings live in
  the log, so nothing is lost.
- **Ratings** go to `<folder>/<UTC day>/chattering-<host>-<pid>-<hex>.jsonl`
  (`0600`, folders `0700`), in the contract's shape. `by` is a person: the
  owner is named as FunctAI names them in their own scripts (the system user,
  `maxime`), so one person's ratings from Python, TypeScript and Chattering
  count as one person's; anyone else by their name in Chattering.
  Rows with known answers follow the contract's rules exactly; the test runs
  every `rated` case of the contract (copied to `test/fixtures/functai-rated`),
  and a check on a real log gave identical rows in Chattering, FunctAI
  TypeScript and FunctAI Python.
- **The job, and the page it makes.** *Show me what my AI program actually
  does, and let me tell it when it is wrong, in seconds.* So the page is the
  examples, not a dashboard (the first build was a dashboard: six number
  cards, six filters, hashes and timings before any example; it lost to the
  Program Atlas mockup and was rebuilt, 2026-09-27). Top to bottom:
  - the promise: name, the instruction's first paragraph, and the **arrow
    signature** (`message → shipping · billing · product · account`: the
    input names, then the allowed answers when the reply form lists them,
    else the output names);
  - one sentence of use (`46 answers this week · 1 failure`) and **the one
    number that matters**, *right, measured* — or, before anyone has checked,
    "How often is it right? Nobody knows yet. **Check 20 random answers**";
  - **Examples**: input → output rows. Pills show a slice (not judged, right,
    wrong, disputed, failed); *it answers* shows the spread of answers as bars
    that filter when clicked. A row opens **in place**: the whole input and
    output, "Is **billing** right for this?" ✓ / ✗, and folded away what the
    model saw (as a conversation) and details in words (when, from which
    notebook or conversation, which model, how long). Judging moves on to the
    next unjudged example; `j`/`k`, `1`/`2`, `esc`.
  - ✗ asks one question: **"What should it have said?"**, with the allowed
    answers as buttons (`1`–`9`), or a field shaped by the answer's type, a
    note, and "I don't know the right answer". A wrong row then reads
    ~~billing~~ ✗ wrong · should be **product**.
  - **Check 20 random answers**: one at a time, dots filling green and red,
    then "12 of 15 were right" and the rate with its likely range.
  - **Compare versions** (only when there are two): the questions both
    answered where the answers differ; click the answer that is right (one
    click judges both), or "neither"; a scoreboard (v1 was right · v2 was
    right · to judge) ends with what the change did.
  - **Answer key**: the examples with a known right answer, what the next
    version is tested against, with the two lines of Python and TypeScript
    that read them, and CSV / JSON-lines downloads.
  - **About**: the whole instruction, how it runs (models, time, tokens,
    failures) in sentences, versions named v1, v2… (hashes in small print),
    who calls it, where the code is.
  Versions are named by first appearance, never by hash, on every screen. The
  list (`#programs`, and right panel → **Programs**, same All / Project
  switch) shows each program with its signature, its instruction and one line
  of status.
- **Agents.** Every Pi run Chattering starts gets
  `FUNCTAI_CALLER={"kind":"agent","conversation":<key>,"user":…}`, so a
  script an agent runs is linked to its conversation. With *record the calls
  agents make* on (owner only, off by default, on the `#programs` page) it
  also gets `FUNCTAI_LOG_CALLS=<the folder>`. New agent processes only.
- **Access.** Every route is `member` (policy.js): the log holds what people
  typed, like transcripts. Guests and walled people get nothing. The recording
  switch is `owner`.

### Trade-offs, stated

- **The allowed answers are read from the prompt.** The log names a
  program's signature by hash, not its field shapes, so the signature's
  choices and the correction buttons come from the reply form FunctAI's
  layouts write ("one of: a, b, c"), else from the answers seen, else a field
  shaped by the current value. A hand-written template loses the choices. Proposed contract addition: the signature's plain data (lmcc's
  shared form) on the call record, or one `functai_program` line per version.
- **Pushed, not polled** (since 2026-09-28, see "Live" below). Before, an
  open program page asked every five seconds whether the log changed.
- **One folder per install.** Other machines' logs arrive only when that
  machine's Chattering reads them; bringing them home needs design/52's sync.
- **Program identity is name + module** (the contract's). TypeScript's module
  is the file's base name, so two `team` functions in two `index.ts` files of
  different projects are one program. The page lists every file it came from.
- **Notebook runs are linked only when the kernel says so.** rat should set
  `FUNCTAI_CALLER={"kind":"notebook","notebook":<path>}` for a document's
  kernel (a change in rat, not here).

### Chattering's own AI programs (2026-09-27)

Every single-turn model call Chattering makes is now a FunctAI program
(`ai-programs.js`), 37 of them: conversation_title, timeline_labels,
project_title (projects and epics), note_title, document_commit_title;
session_problems, problem_note, parent_note; conversation_evidence,
section_evidence, evidence_merge, epic_story; memory_dialogue, memory_tools,
project_overview, intent_weigh, intent_weigh_changes, project_intent,
project_environment, project_status; review_repair; speech_script,
reply_digest, voice_gate; and doc_<command> for the 13 editor commands.
`runPi`, `runPiJson` and `modelJson` are gone.

- **Instructions kept, reply forms replaced.** Each instruction is the old
  prompt nearly word for word; "reply with STRICT JSON in this shape" became
  the program's typed outputs, which FunctAI's layout asks for and checks
  (one re-ask with the reader's hint, instead of the old tolerant JSON
  repair). Output names inside records keep the keys the server reads, so
  the code after each call did not change shape.
- **The transport is Pi** (`pirouter.js`, `piExec`): same sign-ins,
  extensions and billing as before, the model of settings → model, the same
  health pauses, background permissions, usage ledger (now under the
  program's name). The system message goes to `--system-prompt` (a file) and
  the user message on standard input, so the model reads FunctAI's request
  exactly, plus the `<cwd>` section Pi adds to any system prompt. Before, the
  model got Pi's coding-assistant system prompt and the input as an attached
  file. A re-ask with earlier turns is folded into one message quoting them,
  because `pi -p` takes one message; the call log shows the structured
  request. The spoken-word programs use the chat router to the voice model.
- **Why not lm15 as the transport:** lm15 does not yet speak for Pi's
  sign-ins and extension providers (the Claude Code provider some installs
  use), and a quiet move to an API key would change who pays. The router is
  one file to swap when it does.
- **The editor commands keep their design** through FunctAI templates: the
  material in tags with a random suffix no document can close, the whole
  reply as the new text, streamed as Pi writes it (raw, leading space kept).
  Their usage purpose is now `doc_<command>` rather than `ai-command`.
- **Logged, with who called:** `caller: {kind: "chattering", conversation,
  project, epic, file, user, automatic}` as they apply, never inherited from a
  `$FUNCTAI_CALLER` the server process carries. Inputs over 128 KiB (whole
  transcripts) are logged as sizes only; everything else with its values.
  `FUNCTAI_LOG_CALLS=0` keeps them out of the log. In the Programs list they
  form their own group, *Chattering itself*.
- **Renaming is a correction.** A conversation title the program wrote keeps
  its call id; a person renaming it writes a rating (`wrong`, the new title as
  the answer, origin `edit`, by that person). Only the first rename after an
  AI title counts: after it, the title is the person's.
- **FunctAI is vendored** (`vendor/functai/0.1.0/functai.mjs`, one ES module
  with lmcc 0.8.4 and lm15 1.0.0-rc.2, built by `scripts/vendor-functai.js`
  with the esbuild in Chattering's Pi runtime; `SOURCE.json` pins the
  commits). When FunctAI is on npm it becomes a line in
  `runtime/package.json`.
- **Not programs, on purpose:** the notebook derived from an answer and the
  simpler rewrite of a reply (both need the conversation's own Pi session and
  cached context), and the TypeSafe voice commands (their choices are what is
  on screen that moment).

Found on the way, for upstream:
- **lmcc** declares `"sideEffects": false` while its entry imports
  `./plan.ts` and `./serde.ts` for their effects; any bundler drops them.
  The vendoring script builds with `ignoreAnnotations`.
- **FunctAI**: where a function was defined is found by skipping frames whose
  path matches `/functai/ts/src/`; bundled, FunctAI's frames are the bundle's
  and every program claims to live inside it, and the check never matches
  Windows separators. The vendoring script patches both (one marked line);
  FunctAI should compare against its own module URL.

### Live (2026-09-28)

*Watch Chattering's AI programs while they run.* Every call of one of
Chattering's own programs is now a FunctAI stream (functai
`contract/streaming.md`: the same call, watched; it asks, retries, logs and
ends exactly as a plain call). The Programs pages show it as it happens and
say, unasked, when anything reaches the log.

- **What a person sees.** On the list, *Running now*: each call running,
  across all programs (the newest twelve, then a count), with what it is for
  (its conversation, project or file), whether it runs in the background or
  who asked, what it is doing (waiting for the model, thinking, writing,
  asking again) with the time so far, and the newest words of its answer. On
  a program's page, the same above its examples, in the table's columns; a
  row opens in place: the whole input, each output filling in as it is
  written (the ones not started yet shown as "…"), the model's thinking
  (folded), and why it was asked again. When a call ends it moves into the
  examples; if the person was watching it, it opens there, ready to judge.
  A program whose first call is running has a page before it is in the log.
  On other tabs, a word in the status line (`● running now`) leads back. The
  right panel marks programs running now. Other writers' calls and other
  people's judgements appear as they reach the log.
- **Provisional, and says so.** Text shown while a call runs is the raw text
  of each output (structured outputs as the JSON being written); the checked,
  typed value is the finished example's. A retry (an unreadable reply, a
  provider error) wipes what was written and says why, as the contract's
  law 3 asks. A reply that arrives whole (the voice model, which does not
  stream here; a cached reply) appears whole.
- **The document commands** show the reply exactly as the model writes it
  (their answer is the whole reply, which FunctAI's reader only sees whole),
  through the same listener that streams it into the editor.
- **Thinking.** The Pi router now passes the model's thinking through the
  stream as well as the text (`thinking_delta`), so a streamed call's record
  holds the thinking exactly as a plain call's did. Without this, streaming
  every call would have dropped the thinking from the log.
- **How it travels** (`programs-live.js`, server.js "AI programs, live").
  The server keeps, per call running and for 30 s after it ends (at most 40
  ended), what a watcher sees; changes leave as small ops (start, text,
  thinking, reset, end, gone), text gathered for 60 ms, each with the call's
  version. A tab on the Programs pages, or with the panel open, follows with
  its existing event stream's id (`POST /api/programs/live`), gets a snapshot
  on that stream and then every op in order, so nothing is missed or counted
  twice; it stops following when it leaves or is hidden. No other tab
  receives anything. When the log moves the followers get `{op: "log", seq,
  programs}`: the programs that changed, so a page on another program stays
  still (a person may be reading it). Other writers are seen by watching the
  log folder and its two newest days (the nearest existing parent until the
  folder exists), with a look every 15 s as a safety net for file systems
  that do not report changes.
- **Access.** `program-live` events follow the Programs pages' rule
  (members, never guests or walled people), narrowed per call: a call about
  a conversation, project, file or repository reaches only people who may
  see it (policy.js). The follow route is `member`.
- **Values follow the log's rule.** A call whose inputs are logged as sizes
  only (over 128 KiB: whole transcripts) shows its inputs as sizes only, and
  no error message.

Trade-offs, stated:
- **Outputs of size-only calls are shown while they run, and not kept.** The
  notes, evidence and memory lanes read whole conversations, so the log keeps
  only their sizes (a storage choice, not a privacy one: their outputs reach
  the same people through the notes and memory pages). Their answers type
  out live, then the finished example says "not recorded".
- **Only the outer call.** A call inside the call (a module's step, a tool)
  shows in the log as its own call, not live inside its parent. Chattering's
  programs call none.
- **The voice model does not stream** (one chat completion); its three
  programs appear whole when done.
- **Only Chattering's own calls are live.** Scripts, notebooks and agents
  appear when their call ends: FunctAI writes a call to the log only then,
  and its stream events stay inside the process that made the call. Making
  those live needs a FunctAI contract change (a `started` line, or a live
  events file), in all four languages.
- **Watching cannot stop a call.** Closing the page stops the watching;
  there is no stop button on a running call.
- **The vendored FunctAI is 0.1.0 (2026-09-27).** FunctAI has moved on
  since (API names, optional inputs, the reply cache); re-vendoring is a
  separate change.

### Verified

- `test/programs-live.test.js`: ops in order with versions, text gathered;
  a retry and tool results void the text; a follower joining mid-call gets
  a snapshot and then only what is new; failures, cancellation and a stream
  that breaks off; sizes-only calls; limits; raw text; inner calls; ended
  calls kept and dropped.
- `test/ai-programs.test.js`: real FunctAI streams through the Pi router,
  the live id is the log id, the record unchanged but `streamed`; thinking
  watched and recorded whole (streamed or not); a stop signal gives
  `ABORTED`, a cancelled call, `Cancelled` in the log; a document command's
  raw text once.
- `test/policy.test.js`: `program-live` narrowed per call, never to guests.
- `test/programs-live-app.test.js`: the real app, server and a fake Pi that
  writes slowly and waits at a gate: the list, the panel, the call's page
  before its first call is logged, the text so far and the thinking, the
  time ticking, landing opened in the examples; a reply that cannot be read,
  asked again, its text replaced; another writer's call on another program
  leaving the page still, on this program showing; the list updating
  unasked; following stopping off the pages.
- A real `problem_note` call on `openai-codex/gpt-6-astra` through the real
  Pi: the note arrived in 36 pieces over 3 s, the first 1.7 s after the start.

### Verified (phase 1)

- `test/programs.test.js`: every `rated` contract case; the folder rule;
  reading every writer and day, skipping non-records, waiting for a partial
  line; ratings written as lines and read back; disputes, withdrawals,
  wrong-with-no-answer; random draws and the measured share; versions and
  comparison; rebuild after deleting the index; `log_content` off.
- `test/programs-app.test.js`: the real app in Chromium, from the list to a
  judged row, a correction, a random draw, the comparison, the data rows and
  CSV, the right panel, and a phone width.
- A real log (Python `evaluate` on FunctAI's 80 support tickets, before and
  after the house rules; a module with a tool; a TypeScript program on Claude,
  with one failed call) read and rated in a separate Chattering instance.

---

## The idea in one line

An AI program is a first-class thing in Chattering, like a conversation or a
notebook: you can see what it is, every time it ran, say 👍 or 👎, and those
ratings become the data that measures and improves the next version. The same
program can then be called from a notebook, an agent, a keyboard shortcut, or
by a colleague through a company install.

## What FunctAI already gives (read in `~/Projects/functai`, 2026-09-26)

- **A program is a typed function.** `@ai def team(message: str) ->
  Literal[...]`: name, docstring and types are the contract; lmcc writes the
  prompt and reads the reply back through the same template; lm15 sends it.
- **Free inspection.** `fn.render(...)` builds the exact request without
  sending it; `explain()` and `signature_text()` describe the layout.
- **Measurement on plain rows.** `evaluate(fn, rows, expected=...)` gives a
  score with a range and a table with one row per example (prediction, score,
  error, seconds, tokens). `compare(before, after)` pairs the rows: better,
  worse, and a range for the difference.
- **Improvement ladder.** Rules in the docstring, tighter types, examples,
  `fn.opt(trainset=...)` (keeps runs that were right as worked examples),
  `fn.using(lm=...)` for another model, `fn.bake(...)` to train a small model
  with calibrated probabilities and an escalation threshold.
- **A portable unit.** `check` → `save` → `verify` → `load`. The saved folder
  holds `functai.json` (each node's typed field shapes, instruction, examples,
  **signature and request fingerprints**, probes), `code/`, a pinned
  `requirements.lock`, optional `recordings.json`. Keys are never saved.
  `load` runs code, hence `trust=True`.
- **Honest failure.** `Refusal` codes, repairs listed on the prediction,
  `LoginRequired` that never switches to a paid key, `StepLimit`.
- **The gap.** Call history is an in-memory deque of 500 `CallRecord`s
  (`engine.py`): function name, model, lm15 request/response, cache flag,
  error, time. Nothing persists, there is no run id, no parent/child link for
  modules and tool loops, and no link to which version of the program ran.

## Principles

1. **FunctAI defines what a program is; Chattering stores and shows it.** No
   second signature system inside Chattering. Chattering's own 26 model calls
   move to FunctAI TypeScript instead of a Chattering-only wrapper.
2. **rat computes** (design 63). Evaluation, optimization and baking run in
   rat kernels, from small notebooks the person can read and rerun. Chattering
   does not embed a Python evaluator.
3. **Recording is the product, and it is chosen per program:** full content,
   shape only (sizes, timings, tokens, fingerprints), or off.
4. **Every number says how its rows were chosen.** Rated runs are not a random
   sample; a score is only computed on a set drawn for that purpose.
5. **Local first.** The company hub is the same install with more people
   (designs 46, 52, 69), not a second product.

## The one piece to agree now: the run record

This is the only part that blocks everything else, and it belongs in FunctAI
while the TypeScript port is being written, so Python and TypeScript emit the
same thing from day one. A JSON Schema plus fixtures in the FunctAI repository,
checked by both implementations (the lm15-contract pattern).

One record per program call (a module or tool loop produces a tree):

| field | content |
|---|---|
| `run_id`, `parent_run_id`, `root_run_id` | UUIDv7 (time-ordered); a module's inner calls and each tool step are children |
| `program` | qualified name (`module:name`), language, FunctAI version, `signature_fingerprint`, `request_fingerprint`, `saved_version` (hash of the saved folder, when loaded from one), source location (file, notebook path and cell, line) |
| `inputs`, `outputs` | typed JSON per field, shaped by the signature; or `error` `{code, message}` (`Refusal` code, `LoginRequired`, `StepLimit`, provider error) |
| `calls[]` | each model request/response in lm15 canonical JSON (retries and tool steps included), model, provider, usage, duration, `cached`, `repairs`, `probabilities` |
| `caller` | kind (`notebook`, `script`, `conversation`, `agent`, `api`, `shortcut`, `schedule`), user, host, conversation key or notebook path |

**Delivery: an append-only JSONL spool file**, not HTTP from inside the call.
`functai.configure(record=...)` takes a callable or a path; the environment
variable `FUNCTAI_RECORD=<dir>` turns it on, and rat/Chattering set it for the
kernels and workers they start. Chattering tails the spool and indexes it.
Why: no network in the hot path, nothing slows or fails the call, and records
survive a crash or Chattering being closed. Trade-off: the spool is local to
one machine; remote hosts need the sync path of design 52 to bring runs home.

**Why not OpenTelemetry's GenAI conventions as the primary format.** They are
the industry standard for tracing model calls, and Langfuse, Arize Phoenix and
Datadog read them. But capturing message content is still opt-in and marked
experimental there, and they have no place for typed signature fields,
fingerprints or corrections, which are the whole point here. So our record is
primary and an OpenTelemetry exporter is a later add-on for companies that
already run an observability stack.

## Where it appears in Chattering

1. **Right panel → Programs**, beside Files and Artifacts, with the same
   All / Project switch (design 67). One row per program: name, signature on
   one line, runs today, runs waiting for review, current version.
2. **The program page** (main view; the Atlas mockup made real):
   - *Runs* — the input → output table, filterable by caller, model, version,
     user, rating, error, confidence; each row opens the full exchange in the
     existing transcript reader, with 👍 👎 on every row.
   - *Review* — a queue: 👎 without a correction, lowest-confidence runs
     first when probabilities exist, and "draw 20 random runs to rate".
   - *Compare* — versions or models on the same rows, with FunctAI's paired
     numbers (better, worse, range).
   - *Data* — datasets built from ratings and imports, with a fixed learn /
     judge split.
   - *Contract* — signature, instruction, the prompt for any input (`render`,
     free), the `check` report.
   - *Use* — how to call it: Python, TypeScript, HTTP, notebook cell,
     shortcut binding.
   - *Settings* — recording level, retention, who may call and see runs, which
     account pays, budget.
3. **In notebooks.** The strip under the editor (design 41) lists this
   notebook's runs with 👍 👎. Later, each AI call's output gets a footer
   (`team · v3 · gpt-4.1-mini · 0.4 s · 👍 👎 · open`); that needs the run id
   to reach the output renderer through rat and MRMD's output registry
   (design 63), so the strip comes first.
4. **In conversations.** A chip on a tool call that produced runs: "▸ 3 runs
   of team". A Pi extension offers published programs to agents as tools;
   their calls carry the conversation key.
5. **In the inbox** (design 50): "Needs review" for 👎 runs without a
   correction, and a new version waiting for its comparison.
6. **On Chattering's own outputs.** Conversation titles, notes and project
   overviews get a small 👎 / ✎. A manual edit is recorded as a correction:
   renaming a conversation is a labelled row for the title program. The row
   shows it came from an edit, and it can be excluded.
7. **Everywhere else**: the command palette ("Run program…"), `chattering run`
   on the command line, and keyboard shortcuts.

## 👍 and 👎, built from the types

- 👍 means *right for this input*, not *nice*. It makes the output a label.
- 👎 opens a correction form generated from the output type: a choice for
  `Literal`/`Enum`, a toggle for `bool`, a number field, one control per field
  of a dataclass, text for `str`. Optional reason tags (the error kinds of the
  Atlas: invented decision, missing item, wrong scope…) and a note.
- A correction is a labelled row, and FunctAI's `evaluate` and `opt` take
  plain rows, so nothing is converted.
- Ratings are per person. When two people disagree, both are shown, not
  averaged.
- Keyboard review: `j`/`k` move, `1`/`2` rate, `e` edit. Fifty runs should
  take minutes.

## The improvement loop

use → rate → dataset → evaluate → try something → compare → publish → use.

Each step is a button that generates a small notebook, runs it through rat,
and stores the result (the evaluation table as Parquet plus one summary row):

- **Evaluate** the current version on the judge set.
- **Try models** (`using`), with cost per 1,000 calls from the price tables
  Chattering already keeps.
- **Improve from rated runs** (`opt`): 👍 runs become worked examples.
- **Bake** (only for fixed-answer outputs with enough labelled rows): train a
  small model on lambda's GPUs; show the report and the escalation threshold.
- **Publish** only when the comparison's range excludes zero, or with an
  explicit override that is written down.

## Local helpers: the clipboard

- `chattering run fix-grammar --clipboard` reads the clipboard, calls the
  program, writes the answer back, and shows a notification. The previous
  clipboard content is kept so one key undoes it.
- A clipboard program is any program with one text input and one text output
  (or a declared mapping). Examples: fix grammar, translate FR↔EN, notes → a
  polite email, pasted text → a CSV table, redact names.
- **Shortcuts are the operating system's job, declared, not grabbed.** Wayland
  does not let an app take global keys: on this machine the binding goes in
  the desktop repository's Hyprland config; GNOME and KDE use the
  GlobalShortcuts portal; macOS and Windows use the native shell (design 62).
- **Privacy.** Clipboards hold passwords. Clipboard programs record shape
  only by default, refuse inputs that look like secrets (the existing
  redaction rules), and can be pinned to a local model on lambda so the text
  never leaves the house.
- **Speed.** Starting Python costs a second or more before the model is even
  called, which feels broken on a shortcut. Chattering keeps a warm runtime: a
  Node worker for TypeScript programs (the fastest path, and a concrete reason
  FunctAI TypeScript matters), a warm rat kernel for Python ones.

## Hosting for a company

- **A published version is a saved FunctAI folder**, identified by its hash,
  and it must pass `verify` in a fresh environment, replaying recordings taken
  from 👍 runs, before it can be published.
- **Channels** (`dev`, `live`) point at versions. Rollback moves the pointer.
- **Calling**: `POST /api/programs/<name>/run` with a caller token, client
  snippets, the agent tool, shortcuts, notebooks. Every call records who.
- **Who pays** is chosen per program: the owner's account and budget, or the
  caller's own. Personal subscriptions (Claude, ChatGPT plans) must not serve
  other people; that very likely breaks their terms. Shared programs need API
  keys or a company account. FunctAI already refuses to switch keys silently.
- **Isolation.** A saved program is arbitrary code. Each version gets its own
  environment from its lock file and runs in a sandbox (the guest sandbox's
  systemd scopes on Linux, a container on a hub) with CPU, memory, time and
  network limits, never inside Chattering's process. Chattering's own shipped
  programs are the only exception.
- **Permissions.** Viewing runs (which can contain customer data), calling,
  rating and publishing are separate rights on top of the existing roles.
  Every new route goes through the closed-by-default policy (design 69), and
  live updates must be filtered per recipient first (an open todo today).
- **Observability** per program: calls per day, error rate, p50/p95 latency,
  tokens and cost, 👎 rate, and drift (the answer distribution this week
  against last week, the classic early warning for classifiers). Every point
  on a chart opens the runs behind it.
- **Retention**: full content 30 or 90 days, metadata longer, set per program.

Honest sequencing: a hub needs the team identity and storage model that
design 46 deferred and that the project status still lists as open. Hosting
comes last.

## Storage

*Superseded by "As built": FunctAI's call log keeps the ratings, so the
index below is a cache and lives in `~/.cache`.*

`node:sqlite`, like `files.db`, `search.db` and `usage.db`, but in
`~/.local/share/chattering/programs.db` plus a `programs-blobs/` folder, **not
in `~/.cache`**: ratings, corrections and datasets are a person's work and
cannot be rebuilt, unlike the other databases, which are derived.

| table | holds |
|---|---|
| `programs` | id, qualified name, project, owner, visibility, recording level, retention |
| `versions` | id, program, saved-folder hash or signature fingerprint, manifest JSON, source (path, notebook, git commit), status (seen, verified, published, retired), verify report |
| `channels` | program, name, version, moved by, when |
| `runs` | run id, parent, root, version, caller kind, user, host, conversation or notebook link, started, duration, model, provider, tokens, estimated cost, status, error code, input / output / exchange blob hashes, max confidence |
| `blobs` | sha256, size, compressed bytes (large inputs such as transcripts are stored once) |
| `feedback` | run, user, rating (+1/−1), correction JSON, reason tags, note, source (click or implicit edit), time; one per user and run |
| `datasets`, `dataset_rows` | name, program; input, expected, origin (feedback, import, manual), split (learn / judge) |
| `evaluations` | version, dataset, metric, score, low, high, Parquet table path, notebook path, time |

Indexes on `runs(program, started)`, `runs(root_run_id)`, `feedback(run)`.
Datasets export to JSONL and Parquet so `dpyr.read` takes them directly.

## Which language

- **A one-call program is data, not code**: instruction, typed input and
  output shapes, template, examples, model settings. All 26 of Chattering's
  own programs are of this kind. lmcc's signatures and adapters already have
  one plain-data form that the Python and TypeScript kernels read identically
  (lmcc `ts/README.md`, kernel 0.8.4). Store such a program as one JSON file:
  Chattering runs it in TypeScript, a Python notebook evaluates and improves
  it, and the improved examples are written back to the same file.
- **Only programs with code of their own** (tools, multi-step modules) belong
  to a language, and are saved as FunctAI folders in that language.
- **TypeScript for running inside Chattering**: same runtime (Node), no
  Python to ship with the desktop installers (design 62), instant start for
  shortcuts. The packages ship JavaScript, so Chattering stays plain JS.
- **Python for measuring and improving**: `evaluate`, dpyr tables and baking
  (torch, GPUs) stay there; they are not worth rebuilding in TypeScript.
- **TypeScript's types disappear when the code runs**, so FunctAI TypeScript
  cannot read `Literal[...]` the way Python does. Shapes must be values (lmcc's
  `t.*` builders, which also give the static type), not annotations alone.
- **Cost**: two FunctAI implementations must agree; they need a shared corpus
  of fixtures, as lm15 and lmcc have.

## Chattering's own 26 programs

*Done (see "Chattering's own AI programs" above), through Pi rather than
lm15 for the reason given there.*

## Phases (each useful alone)

0. **Run record contract** in FunctAI, Python implementation plus the JSONL
   spool; the TypeScript port adopts it as it is written.
1. **Programs panel and program page**, read from the spool: Runs, Contract,
   👍 👎 with typed corrections, the notebook strip.
2. **Chattering's own programs on FunctAI TypeScript**, title first, with
   implicit corrections.
3. **Datasets, Evaluate, Compare, Try models, Improve** through rat notebooks.
4. **Triggers**: `chattering run`, clipboard shortcuts, the agent tool, HTTP on
   one's own machine.
5. **Company hub**: publish, verify, channels, sandboxed runtimes, permissions,
   budgets, dashboards, baking on GPUs.

## Decisions for Maxime

- **D1 — Recording path.** JSONL spool (recommended) or HTTP to Chattering.
- **D2 — Default recording level.** Recommended: full on your own machine,
  shape only for clipboard programs, chosen explicitly per program on a hub.
- **D3 — Who pays on a hub.** Owner, caller, or per program (recommended).
- **D4 — 👍 means correct.** Recommended yes; no separate "nice" rating.
- **D5 — Notebook footer.** Accept the strip first, the per-output footer
  when rat and MRMD can pass a run id.
- **D6 — Name in the interface.** "Programs", "AI programs" or "Functions".

## What would change this

- A company that already runs Langfuse or Datadog: the OpenTelemetry exporter
  moves up, and Chattering becomes the rating and improvement layer on top.
- FunctAI TypeScript taking longer: phases 0, 1 and 3 work with Python alone;
  only phase 2 and the fast shortcut path wait.
