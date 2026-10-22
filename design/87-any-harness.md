# 87 — Any harness: Pi, Claude Code and Codex in one conversation view

> **October 1, 2026 follow-up:** `design/agent-composer/README.md` contains the
> code-backed experience audit, current primary-source research, proposed
> shared-composer contract and interactive prototype (steps 1–3). Use that
> package for the forward design. This older note mixes plans and historical
> implementation claims; the audit corrects several, including Codex process
> topology, dropped queued briefs and the household-account permission gate.

Status (2026-09-30): Pi's live HTML composer and **Codex, end to end**, are
wired and tested (see "Codex: built" below). Claude Code has an isolated
driver prototype, not yet connected to web runs. Cross-harness switching and
side-by-side are not started. Probe versions: Claude Code 2.1.284–2.1.285,
Codex 0.153.4, Pi 0.87.1. Follow the market 80/20: three harnesses, one
timeline, a picker, handoff, and safe side-by-side answers.

## Codex: built (2026-09-30)

- **History.** `harness/codex-transcript.js` reads all three generations of
  Codex files (mid-2025 `.json`, early JSONL, current JSONL) into the common
  transcript shape: what the person typed (not injected instructions or IDE
  context), answers, reasoning, tool calls and results, pictures (served
  lazily), usage from Codex's running token total, and forks (Codex refers to
  the original's history up to an ordinal; the reader follows it, keeping the
  original's entry ids so the tree joins them). Conformance: for every thread
  Codex's own app-server can read, the reader's user messages and answers
  match (`scripts/codex-conformance.js`). Timeline, search, semantic search
  and the tree include Codex; source mark `X`.
- **Imported copies.** The Codex app imports Claude conversations as
  text-only copies (141 of 241 files here). `harness/codex-links.js` links a
  copy to its original only on strong evidence (same folder, same first typed
  message, copy made later); linked copies leave lists and search, unlinked
  ones stay visible with an "imported" label.
- **Runs.** `harness/codex.js` drives one shared `codex app-server` (as the
  Codex desktop app does); `harness/codex-runs.js` ties it to jobs, live
  tails, run cards, approvals and re-indexing. Streaming, stop (interrupt),
  approvals from the run card, queued follow-ups, Codex's own compaction,
  attached context handed over once via `thread/inject_items`, context meter
  from Codex's token count and window, per-conversation model / reasoning /
  access (`config`, read-only, this folder, full). Codex allows one writer per
  conversation: Chattering holds it while in use, lets go after idle or on
  request, refuses one another Codex holds, and "open in Codex terminal"
  releases first. Shutdown stops the app-server.
- **Compose box.** `harness/codex-composer.js` + `codex-ui.js`: `@` uses
  Codex's fuzzy file search; `/` offers the Codex controls Chattering has;
  model and reasoning lists come live from Codex (`model/list`), plan and
  usage limits from its account calls. New conversation screen: Pi / Codex.
- **Fork and edit.** Fork at a turn via `thread/fork` (whole turns only: a
  fork at mid-turn text includes the rest of that reply, and says so). Edit a
  question = fork before it with the text prefilled. Only conversations with
  saved turn ids (Codex 0.150+; 20 of the 100 native ones here, and every new
  one) can fork at a chosen message; Codex itself refuses older ones.
- **Deliberately not for Codex:** regenerate, side-by-side answers, merge,
  in-place edits, notebooks, review targets. Codex keeps one line of answers
  and owns its files; Chattering never writes a Codex file.
- **Owner only.** Guests and sandboxed identities are refused (menus, runs,
  forks): Codex would run under the owner's ChatGPT login.
- Verified live with real Codex (index of 241 real files, menus, draft →
  conversation, context hand-over honoured, lock released), then the test
  conversation deleted with `codex delete`.

- **Everywhere else a conversation is used (2026-09-30, later).**
  - *File edits*: `harness/codex-diffs.js` reads Codex's `apply_patch` (the
    tool, and the older `apply_patch <<EOF` scripts) as Chattering edits, one
    per hunk, with outcomes. Files changed, step changes, "review whole
    turn", line history and the file ledger now include Codex (1,012 patches
    in 44 conversations here). Early files keep their folder only in Codex's
    environment note; the reader now takes it from there too (conversations
    without a folder: 4 instead of ~100). Codex rows have their own cache
    version, so Pi and Claude rows are not re-read.
  - *The file ask box* follows the agent it sends to: Codex targets show
    Codex's model and levels (the box keeps Codex choices apart from its Pi
    ones), the brief reaches Codex as a developer message for that request,
    and "new Codex conversation" is offered when Codex is installed. Codex
    conversations that edited the file are offered as targets.
  - *Marked-up file feedback* opens `codex resume --image` for a Codex
    conversation. Before, it opened Pi on the Codex file.
  - *Code reviews* can be sent to Codex conversations (owner only).
  - *An older model Codex no longer lists* is shown as the conversation's
    model (it is what the next message is sent with), not Codex's default.

## Antigravity CLI and Muse Code: built (2026-10-14)

Google's `agy` (Antigravity CLI 1.3.4) and Meta's `muse` (Muse Code 1.4.6)
join as agents **only their own program continues**, like Claude Code: they
are read here and run in their real interactive program on the live
terminal (design/91). Chattering's own box, regenerate, branch, merge,
compact, reasoning control, fork, edit and the file "ask" box refuse them by
name (`ownProgramOnly`, `refuseOwnProgramOnly`), so no Pi code ever touches
their files.

- **History.** `harness/agy-transcript.js`: one SQLite database per
  conversation (`~/.gemini/antigravity-cli/conversations/<id>.db`), steps as
  protocol-buffer `gemini_coder.Step` messages, read by field number (the
  numbers come from the definitions compiled into `agy`, and protocol
  buffers never renumber). Typed messages, answers, its visible thinking,
  tool calls with results, pasted pictures, token use, folder and branch.
  The database is in write-ahead mode: the index's stat and the watcher
  follow `<id>.db-wal` too, else a running conversation looked unchanged.
  Opening it read-only makes SQLite create the usual `-wal`/`-shm` beside it
  (any reader does; `agy` uses them as normal).
  `harness/muse-transcript.js`: `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/
  session.jsonl`, an event log (retained frames unwrapped); helpers'
  `subagent/` logs are not conversations. A turn that failed (usage limit,
  rejected key) shows as "stopped: <reason>".
- **Live.** Profiles `agy` and `muse` (`harness/terminal/profiles.js`,
  screens recorded 2026-10-14). Both pick a new conversation's id:
  Antigravity writes its database with the first message (found by folder,
  then by the file its process holds); Muse Code makes its folder as it
  starts and records its own process id there (found exactly). Resume:
  `agy --conversation <id>`, `muse resume <id>`; both append to the same
  file. Reader fixes this needed (general rules): an option numbered with a
  wide gap ("1  Trust and continue"), and a `/` menu inside the box's frame.
- **One writer.** A program opened elsewhere is recognised (`agy
  --conversation`, `muse resume`, or the file it holds open: Muse Code's
  session `cron.db`), so Chattering refuses to start a second one.
- **Lists.** Muse Code makes a conversation file even when nothing is typed:
  such blank runs stay out of the list until they hold a message.
- **Settings.** On ("always") by default, offered only when installed
  (`agentsInstalled`); "let me choose" does not exist for agents with no
  Chattering box. Overrides: `CHATTERING_AGY`, `CHATTERING_MUSE`.
- **Not yet.** Chattering's artifact tools are not given to them (neither
  takes an MCP server for one run only); Antigravity stores its model as an
  internal id, so its model name is not shown; their file edits count in
  "files changed" but have no line diffs (no `apply_patch` equivalent
  read yet); cross-harness switching, as for the others, is not built.
- **Tests.** `test/agy-muse-transcripts.test.js` (a real `agy` database as
  fixture), reader cases in `test/terminal-reader.test.js`, the opt-in real
  run in `test/live-terminal-real.test.js` (`CHATTERING_REAL_AGENTS=agy,muse`;
  their trust lists are put back exactly).

## Modes for every agent: built (2026-10-14)

Pi's prompt modes (the ModeDef files in `~/.pi/agent/modes`) now apply to
all five agents, switchable mid-conversation, one record per conversation.
Pi keeps its own (`/mode`, recorded in its session). For the others
`agent-modes.js` keeps the current mode, the switches, and what each agent
was already given; the server hands a switch over the way each agent can
take it. Each route was measured first (mode A "end with HERON", switch,
mode B "end with FALCON", same conversation) and then verified end to end
through the page on a test copy:

| Agent | How a switch reaches it | When |
|---|---|---|
| Claude Code | `--append-system-prompt` with `--system-prompt-snapshot off` (2.1.29x freezes its prompt at the first request by default and ignores a new one on resume) | its program restarts on the same conversation once idle |
| Codex | a marked developer message (`thread/inject_items`): Codex ignores new `developerInstructions` on resume, warm or cold. A new thread starts with it as its developer instructions | Chattering's box: before the next reply; its own program: injected just before it restarts, once idle |
| Antigravity | a `PreInvocation` hook (`harness/agy-mode-hook.js`) in `~/.gemini/config/hooks.json`, inert unless Chattering started `agy` (`CHATTERING_MODE_FILE`); the shell answers `{}` itself outside Chattering | its next model call, no restart |
| Muse Code | a marked block before the person's next message (no setting, no documented hook, no import); the screen is made tall while it is typed so the closed loop can check it; long pastes fold to `[Pasted Content N chars]` | with the next message |
| Pi, own program | Chattering types `/mode <key>` | once idle and its box is empty |

- **Words.** `# Current prompt mode: <label>` + opener/appendix (or a whole
  `systemPrompt`, given as added instructions: the agents' own prompts and
  tools stay theirs). `removeSections` and `tools` are Pi-only.
- **Replace vs add.** Claude Code and Pi replace the mode (the prompt is
  rebuilt; the provider cache breaks once, as a Pi mode switch does).
  Codex, Antigravity and Muse Code add a "from now on" message: the cache
  holds; earlier modes stay above in the history, the latest wins (it did
  in every test).
- **Record.** Switches show as "▣ mode: …" bars from the agents' own files
  (Codex, Antigravity, Muse Code); Claude Code's file has none (the store
  has them). The mode button is in Codex's box, the draft screen (every
  agent), and the bar of every agent's own program; "none" is offered for
  agents other than Pi.
- **Found on the way.** Muse Code shows a grey hint in its empty box ("Type
  @ to search…"), not dim: the reader took it for typed text and every
  message sent from Chattering after a pause failed (`hintAtCaret`).

## Switching agent: built (2026-10-14)

A conversation continues with another agent from "Switch agent…" (the +
menu of Chattering's box, "⇄ agent" under an agent's own program). It
opens the draft screen (`conversation-draft.js`, `startHandoffDraft`) as
"continue with another agent": the same page a new conversation starts
from, with the agents that can take it in the agent row, the folder, mode,
words and images of the conversation it leaves, and every setting still to
change before the message goes: model, reasoning level, context and
instructions (Pi, Codex), Codex's access, "in its own program" (Pi, Codex).
It is a draft like any other: kept in this browser, listed with the unsent
drafts ("⇄ title → Codex: …"), discarded like one. Built as the refactor below planned, in
parts: the new agent gets a new conversation of its own, holding the
history in its own form; `harness/chains.js` links the parts; the newest
part stands for the conversation in lists and reads with the earlier parts
above it, a line where it moved ("⇄ continued with Codex (from Pi)").
An earlier part opened directly says where it continues. Verified end to
end through the page on a test copy: one conversation Pi → Codex → Claude
Code → Antigravity → Muse Code (offline) → Pi, each asked a code word only
the history held, and what command an earlier agent ran.

| Into | How the history goes in (`harness/handoff.js`) |
|---|---|
| Pi | a Pi session file written by Chattering, the mode as Pi records it (SHA-256 of its canonical JSON), then answered from Chattering's box (models, reasoning, context, images as the draft set them; two models fan out), or, "in its own program", the page sends the message into Pi's program |
| Codex | a new thread, the history added with `thread/inject_items` between two marked developer messages, then the message (model, effort, access, context, images as set); "in its own program": the thread is made with the history and no turn (`startInjected`; Codex writes its file at once), and the page sends the message into Codex's program, which resumes it |
| Claude Code | a Claude Code session file written by Chattering, then its program resumes it and takes the message |
| Antigravity, Muse Code | no way to load one: a marked block before the person's first message in their program |

- **What carries:** every message and answer word for word; the work as
  past-tense notes under the answer it belongs to (a command and a bit of
  its output, files read and changed); answers labelled "[Answer by …]";
  then a note saying who the conversation was with (without it, Claude Code
  took Codex's answers for its own and "corrected" them). Not carried:
  reasoning, pictures (named), each agent's private state. Over budget
  (240k characters): the oldest turns are left out, and the history says so.
- **Why notes, not tool calls:** the common record keeps commands exactly
  but not the full content of past edits, and each agent's tools differ;
  invented calls would mislead. Real tool calls for commands and reads are a
  possible next step.
- **Readers:** carried copies are marked (`chatteringCarried` on Pi and
  Claude Code entries; Codex's between its marks; the block taken off for
  Antigravity and Muse Code) and left out where the original is shown.
- **Prompt mode** carries into the new part.
- **Not built:** going back to an agent already used reuses nothing of its
  earlier part (it starts a new part with the whole history); switching from
  an earlier part is refused (the conversation goes on in its newest).
- **Own programs take words only:** images attached on the draft are
  refused before sending for Claude Code, Antigravity, Muse Code and the
  own-program choice (they were dropped in silence before); context chips
  and instructions are said to stay behind. Codex and Pi in Chattering's
  box take all of it.
- **A race found by the tests of this (`terminal/pty-holder.js`):** the
  holder's "started" reply and the program's first screen read in one
  chunk lost the screen (the listener went on after the reply's promise
  resumed), and the reader waited for a box already drawn. Output and exit
  now wait for the listener; the holder's test sends both in one chunk.
  Test homes also carry the XDG folders now (`test/helpers/home-env.js`):
  Muse Code's sessions follow `XDG_DATA_HOME` before `HOME`, so a test
  server was reading the machine's.
- **Also fixed:** a message to an agent's own program that first asks
  something (trust this folder?) now waits and goes once it is answered;
  Claude Code's "No response requested." filler is not shown.

## Claude accounts: more than one subscription (built 2026-10-14)

A work and a personal Claude subscription side by side, in Pi and in
Claude Code, signed in the way Claude Code signs in today.

- **The main account is unchanged:** `~/.claude`, the `claude-code` Pi
  provider, Claude Code's own login renewed as always.
- **Each other account is a Claude Code folder,** `~/.claude-accounts/NAME`
  (`claude-accounts.js`), used with `CLAUDE_CONFIG_DIR`: its own login
  (`.credentials.json`) and account state (`.claude.json`, `backups/`);
  the rest of `~/.claude` linked (conversations, `CLAUDE.md`, skills,
  hooks, plugins, history), so a conversation is one file whichever account
  answers; `settings.json` and `settings.local.json` copied one way before
  each start. Not linked because Claude Code rewrites `settings.json` for
  the account it runs as: a fresh folder's first run applied the one-time
  "opus → opus[1m]" upgrade to the shared file (seen 2026-10-14, put back).
  `.claude.json` is seeded once from `~/.claude.json` minus the account's
  identity and caches: onboarding, one-time upgrades, trusted folders.
- **Signing in** from settings → AI accounts → Claude accounts: Chattering
  runs `claude auth login` in a hidden terminal, shows its link, and types
  the pasted code back. By hand: `CLAUDE_CONFIG_DIR=~/.claude-accounts/NAME
  claude auth login`.
- **Pi:** the Claude Code extension (`~/.pi/agent/extensions/
  claude-code-fable-5`, outside this repository; a copy before the change
  is in Chattering's data folder, `backups/`) registers one provider per
  signed-in folder, `claude-code-NAME`, models named "(Claude Code ·
  NAME)", the folder's login renewed with the same code as the main one.
  The modes extension (`extensions/modes.ts`, and the copy in
  `~/.pi/agent/extensions`) gives every `claude-code*` provider the Claude
  Code-shaped system prompt: without it, Anthropic answered the account's
  direct requests with "You're out of extra usage" while the main one
  worked, the same login and the same request otherwise.
- **Claude Code:** a conversation answers as the account chosen for it
  (`claude-account-choices.json`): "as …" on the draft and the switch-agent
  draft, "◉ NAME" under its program (switching restarts it on the same
  conversation once idle, as a mode switch does), its terminal window too.
- **The owner's alone:** other household members and guests get no picker,
  no model of another account (hidden from `/api/models`, refused on a run,
  also when the conversation's model is one), and the routes and events are
  owner-only. Pi typed in a terminal cannot tell people apart: anyone using
  this computer account sees every account's models there.
- **Verified** on this machine with a temporary account holding a copy of
  the main login (removed after; the main login, settings and `CLAUDE.md`
  unchanged by fingerprint): Pi answered through the account directly and
  through the `claude` program; a Claude Code conversation started as the
  account (its process ran with the folder), switched to the main account
  mid-conversation (restarted without it, same file, both answers in it);
  Pi in Chattering's box answered with the account's model. A real second
  account (another Anthropic organisation) is not tested.

## Switching harness inside a conversation: the refactor

Today one conversation is one native file of one harness (`pi:` / `codex:`
keys), and ~90 checks of `source` decide behaviour. Switching needs:

1. **A harness interface** (no visible change): `pi`, `codex`, `claude`
   each provide reader, edit ops, send/start/fork/stop, menus, composer,
   and capabilities (regenerate, side by side, merge, edit in place, fork at
   any message, guests). Callers ask the conversation's harness; the UI
   reads capabilities. Removes the bug class fixed above (a path that did not
   know Codex existed).
2. **A chain above the files.** A conversation = segments, each a native
   session, joined by a "handoff" link (like fork links). Native keys stay
   the identity; a chain index maps any segment to the chain and its newest
   segment. The list shows one row per chain; the reader shows segments in
   order with a divider saying what carried over.
3. **History translation.** Pi→Codex: new thread + `thread/inject_items`
   (tested: Codex remembers injected history). Codex→Pi: a new Pi file
   written by Chattering (as forks are). Messages carry exactly; tool steps
   as text in v1 (untested: foreign tool calls as native items); reasoning
   does not carry (Codex's is encrypted). Too long for the other window: a
   summary plus the recent turns. The first message after a switch re-reads
   the whole history without the provider's cache: slower and costlier once.
4. **One model picker**, grouped by harness. Picking the other harness's
   model in a conversation proposes the switch and says what carries over.
5. **Everything keyed by conversation follows the chain**: attached
   context, model choices, run cards, unread marks, the file ledger's
   attribution, titles, search (one hit per chain), reviews.

Order: 1 first (it pays for itself), then 2+3+4 for Pi↔Codex, then Claude.

Known gaps: a Codex *terminal* session running outside Chattering is not
shown as "working"; Codex's plans, live diffs and review results are shown
as ordinary steps, not dedicated views yet; Mac untested; terms of use to
read before selling.

## Built in this checkout

- `harness/pi-composer.js`: commands from the actual session, native argument
  and file completion, extension provider wrappers, exact provider-owned
  insertion/cursor edits. Per-editor snapshots prevent stale edits crossing
  tabs; completion reads work while a model reply is running.
- `pisdk-runtime.js`, `pisdk-worker.js`, `pisdk.js`: the SDK worker owns the
  composer, including `getEditorText`, reset on reload and session replacement,
  and teardown cancellation. No throwaway RPC probe on the default SDK path.
- `POST /api/node/compose`: bounded, authorized requests; guest completions
  stay in the guest worker. Typing never seizes a terminal-owned session.
- `harness-composer-ui.js`: native HTML completion, IME-safe keyboard and touch
  input, stale-response protection, transcript-refresh recovery. The explicit
  RPC fallback engine retains its older completion route.
- `/model`, `/thinking`, `/settings`, `/tree` open existing HTML controls;
  `/compact` uses the existing web compaction flow; `/reload` runs the SDK's
  reload operation, not a model prompt. Other built-ins remain unsupported.
- `harness/claude-code.js`, `harness/codex.js`: injectable process drivers and
  `*-events.js` compatibility projections for today's Pi-shaped live view.
  They are not a canonical trace format; richer native plans, diffs, dialogs
  and provenance still need their own handling. Do not flatten them permanently.
- Tests include real Pi SDK + real Chromium on desktop and phone sizes,
  recorded Claude/Codex streams, and fake-process lifecycle/approval tests.
  The current development service has not been restarted by this work.

Remaining before exposing the foreign drivers: native transcript indexing,
run dispatch, harness-specific controls, complete request/approval scopes,
credential/sandbox isolation, external session ownership, cancellation failure
recovery, version negotiation, and cross-harness handoff fixtures. Basic
Claude approvals intentionally offer Allow once/Refuse only: its native
permission suggestions may change a mode or persist settings, so a generic
"allow for this conversation" label would be misleading.

## The promise

Choosing Claude Code or Codex feels like choosing a model: same
conversation view, same streaming, same stop button, same approval cards,
same history. The harness runs behind the scenes, on the person's own
subscription, through its official program.

## What was verified (not assumed)

| | Pi | Claude Code | Codex |
|---|---|---|---|
| Driven by a program | Chattering already does (SDK and RPC engines) | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | `codex app-server` (JSON-RPC over stdio) |
| Live streaming | yes | yes: Anthropic stream events (text, thinking, tool_use deltas) | yes: `item/agentMessage/delta`, reasoning deltas, command output deltas |
| Tool approval answered by Chattering | yes (extension dialogs, `uiRequests`) | **yes, tested**: send `control_request {subtype:"initialize"}`, pass `--permission-prompt-tool stdio`; the CLI then sends `control_request {subtype:"can_use_tool", tool_name, input, permission_suggestions}`; reply `control_response {behavior:"allow", updatedInput}` → the file was written | **yes, tested**: `approvalPolicy:"untrusted"` → server request `item/commandExecution/requestApproval`; reply `{decision:"accept"}` → the command ran |
| History from elsewhere | native | **yes, tested**: a Claude session file written by Chattering (user + assistant lines), then `claude --resume <id>` recalled a fact from it | **yes, tested**: `thread/inject_items` with raw Responses items, then `turn/start` recalled the fact |
| Branch from an earlier point | native, in place | copy the path to a new file and resume (Chattering already does: `claudeForkContent`) | `thread/fork` with `lastTurnId` (whole turns only); `thread/rollback` |
| Stop | yes | control request `interrupt` (used by the official SDK) | `turn/interrupt` |
| Send while it works | queue | new user message on stdin | `turn/steer` (needs the active turn id) |
| Model and effort per message | yes | `--model`, `--effort` at start; SDK `set_model` | `turn/start` `model`, `effort` |
| Usage and limits | per message | per message + `rate_limit_event` (5-hour window, utilisation) + `total_cost_usd` | `thread/tokenUsage/updated`, `account/rateLimits/updated` |
| Images | yes | image content blocks on stdin | `localImage` input |

Other facts:

- **Claude transport decision (prototype):** the initial recommendation
  was Anthropic's `@anthropic-ai/claude-agent-sdk` (0.3.285). The prototype
  instead speaks its control protocol to the person's installed CLI,
  avoiding a bundled second executable. Trade-off: Chattering now owns
  protocol-version compatibility. Reassess the official SDK (which can
  select an executable) before release; zero dependencies alone is not a
  sufficient reason to keep an undocumented implementation.
- **Codex: use `app-server` directly, not `@openai/codex-sdk`.** The SDK
  (0.159.2) wraps `codex exec --experimental-json`, which has no approvals,
  fork or history insertion. The app-server has 99 client methods, 81
  notifications and 10 server requests, and Codex generates TypeScript
  types for them (`codex app-server generate-ts`), so the driver can be
  type-checked against the installed version. It is labelled
  experimental: the schema must be regenerated and diffed on every Codex
  update.
- **ACP is deferred, not ruled out.** The inspected adapter publication
  dates were older than the installed CLIs. That is a compatibility risk,
  not proof they do not work. The directly tested native protocols are the
  first prototypes; test ACP adapters before making a final comparison.
- **Codex desktop and the TUI can share a local app-server daemon**
  (`codex agents`, `codex app-server daemon`). Chattering must detect a
  thread that another Codex window holds, as it already does for Pi and
  Claude terminals.
- **Pi's `claude-code` provider is not the Claude Code harness.** It runs
  Claude models inside Pi's loop. The picker must make the difference
  plain: *harness* (Pi, Claude Code, Codex) and *model* are two choices.

## What exists in Chattering to build on

- One engine surface, two Pi engines behind it (`piEng()`:
  `piHeadlessRun(opts, {provider, modelId, thinking, message, images,
  onEvent})` → a handle with `respondUi`). Events reach the page through
  `runEventForwarder`, as text and tool blocks.
- Approval and dialog plumbing: `job.uiRequests` and
  `POST /api/run/ui-response` → `handle.respondUi`. Claude's
  `can_use_tool` and Codex's `requestApproval` fit it unchanged.
- The speed meter, the quiet-run watch, answer cards, fan-out and merge
  consume those same events.
- Claude conversations are indexed and forkable; Codex conversations are
  not read at all.
- 36 places decide behaviour by "is this Claude?" (28 in `server.js`, 8
  in `app.html`).

## The plan

### 1. One driver per harness, one surface

`harnesses/{pi,claude-code,codex}.js`, each exporting:

```
capabilities   { stream, approve, stop, steer, branchInPlace, forkAtMessage,
                 forkAtTurn, insertHistory, images, perMessageModel, parallel }
run(conversation, {message, images, model, effort, fromNode}, onEvent) → handle
               handle: stop(), steer(text), respondUi(id, answer)
fork(conversation, point)          → new conversation
receive(history)                   → new conversation in this harness (handoff)
models()                           → what the picker lists
status()                           → installed? signed in? version tested?
```

Pi's driver wraps today's engines. Each driver turns its harness's events
into the existing text/tool blocks, so the reader, speed meter, cards and
quiet watch work unchanged.

Warm processes: one Claude process per open conversation (stdin stays
open between messages); one Codex app-server for all, threads resumed on
demand. Both are dropped after the idle time Pi warm sessions already use.

### 2. Capabilities replace "is this Claude?"

Every one of the 36 checks becomes a capability question. Features a
harness cannot do natively are done by Chattering:

| Feature | Pi | Claude Code | Codex |
|---|---|---|---|
| Send, stream, stop, approve | native | native | native |
| Retry an answer | native branch | copy up to the question, resume | `thread/fork` to the previous turn |
| Edit a past question | native | copy up to before it | fork to the previous turn |
| Parallel answers | native | one fork per answer | one fork per answer |
| Merge | a message | a message | a message |
| Simpler rewrite | hidden message | visible in Claude's own file (no hidden messages); Chattering hides it in its view | same |
| Switch to this harness | write a Pi session | write a Claude session file | `thread/inject_items` |

Codex branches by whole turns only: branching in the middle of a turn
(after one tool call) is offered on Pi and Claude, not Codex.

### 3. Switching harness

Take the path to the chosen message → the portability record → the
target's `receive`. Version 1 carries text, images, tool calls and their
results, with each harness's tool calls kept under their own names and a
short note naming the tools the new harness has. Sealed reasoning is
carried only to the same company (Claude → Claude Code, Codex → Codex).
Before switching, a small panel shows what carries over.

Tested: both targets used the handed-over history. Not yet tested: long
histories with tool calls from another harness (does Claude accept a
`tool_use` for a tool it does not have? does Codex accept a
`function_call` item for an unknown tool?). If not, those calls are
carried as text. This is the first test to write.

### 4. Codex on the timeline

Read `~/.codex/sessions` (rollout JSONL and the 2025 `.json`), titles from
`session_index.jsonl`. Link the 141 desktop-app copies
(`external-import-turn-1`, text only) to their Claude originals when the
first message and folder match, and show them once.

### 5. Parallel answers that edit files

Two harnesses editing one folder overwrite each other. Version 1: side by
side for questions, and for edits only with separate working copies
(git worktrees, already on design 66's unbuilt list). The side-by-side
demo must use them or stay read-only.

## Delight, in detail

- The harness picker lists only what is installed and signed in, with the
  plan name ("Claude Max", "ChatGPT Pro") and the current usage window
  (both harnesses report it live).
- Approval cards look the same for every harness: the command or the file
  change, Allow once / Allow for this conversation / Refuse. Claude's
  `permission_suggestions` fill the second button.
- Reasoning shows while it streams (Claude thinking, Codex reasoning
  summaries), collapsed when the answer arrives, as for Pi today.
- Every answer card says harness · model: "Codex · gpt-5.6-sol".
- A conversation open in a terminal or the Codex app is never written by
  Chattering at the same time; the page says where it is open and offers
  to take over.
- When a harness update breaks its driver, the page says so and offers
  "open in terminal"; nothing is lost.

## Risks

1. **Terms of use (check before selling).** Chattering starts the
   person's own official programs under their own login; it does not
   collect credentials. Whether Anthropic and OpenAI allow a third-party
   product to drive their subscription harnesses this way must be read in
   their current terms, not assumed.
2. **Weekly updates.** Claude Code shipped 25 versions on this machine;
   Codex is 0.153 installed and 0.159 published. Tests on recorded real
   sessions per harness version; Codex types regenerated and diffed at
   start; a "tested up to" version per driver.
3. **Writing Claude's session files** is not a published format. It works
   today (tested). The Agent SDK's own session options must be checked
   first; if they can seed a history, prefer them.
4. **Guests.** Guests run Pi inside their walls. Claude Code and Codex
   under a guest need the same walls and their own logins: owner-only in
   version 1.
5. **Mac.** Everything above is tested on Linux only.

## Order

1. Codex reader on the timeline, with duplicate linking.
2. Claude Code driver (Agent SDK) in the conversation view: send, stream,
   stop, approve.
3. Codex driver (app-server): the same.
4. Harness picker; capabilities replace the 36 checks.
5. Switch harness (carry-over panel), after the unknown-tool test.
6. Side by side, with worktrees.
