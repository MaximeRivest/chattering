# Headless harness integration (in progress)

See `design/87-any-harness.md`. This directory is not yet a replacement for
Chattering's Pi runner or a claim of feature parity with three native apps.

## Wired into the app

`pi-composer.js` hosts Pi's real `CombinedAutocompleteProvider` in the same
SDK worker as the conversation. Extensions' `addAutocompleteProvider`
wrappers and async command argument completions are retained. The HTML
editor asks for suggestions and then asks that provider to apply the chosen
one; it does not reconstruct filename quoting or custom insertion rules.

The browser/worker exchange is:

- `commands`: current session commands, templates and skills, plus supported
  web controls from `compose-commands.js`.
- `complete`: text, UTF-16 cursor position, editor ID; returns suggestions and
  an opaque short-lived snapshot ID.
- `apply`: the same text/cursor, snapshot ID and selected item index; returns
  the provider's exact replacement text and cursor.
- `cancel`: invalidate that editor's query.

The API requires conversation `act` permission. An editor ID is scoped to the
signed-in person, and guest work uses the existing sandboxed SDK worker.
Different tabs cannot consume one another's snapshots. Reload, replacement,
shutdown, newer queries, expiry and changed drafts invalidate old edits.
Queries bypass the running turn's request queue but never submit prompts.
An empty box asks nothing (unless Ctrl+Space), so opening a conversation
does not start Pi. The first real query opens a cold session: it executes
trusted Pi startup hooks, and Pi may persist initialization settings (a
`thinking_level_change` line in a file that lacks one, as its terminal does). It is not a side-effect-free parse of
an untrusted file. Extension code keeps its existing trust and OS boundaries.

`/model`, `/thinking`, `/settings`, `/tree` open HTML controls. `/compact`
uses the existing compaction route. `/reload` uses the SDK reload lifecycle.
Other built-in terminal screens have not been implemented. A TUI-only custom
extension view still uses the old compatibility renderer; arbitrary terminal
components cannot automatically become native HTML widgets.

The deliberate RPC fallback engine retains the old command probe and file
completion; it does not acquire a second SDK session just for completion.

## Codex: wired (see design/87, "Codex: built")

- `codex.js`: the app-server driver (one shared process, thread locks, fork).
- `codex-runs.js`: runs, approvals, queued follow-ups, compaction, context
  hand-over, per-conversation model/effort/access.
- `codex-transcript.js`: read-only reader for all Codex file generations.
- `codex-links.js`: links the Codex app's imported copies to their originals.
- `codex-diffs.js`: Codex's `apply_patch` edits as Chattering edits (one per
  hunk), for files changed, review, line history and the file ledger.
- `codex-composer.js`: `@` and `/` for Codex conversations.

Tests: `test/codex-*.test.js` (reader, server, runs through a stand-in
Codex in `test/fixtures/fake-codex.js`, and the page in Chromium).

## Prototypes, not routed to normal conversations yet

- `claude-code.js`: the installed CLI's stream-json/control protocol.
- `claude-events.js`, `codex-events.js`: compatibility projections into the
  existing live-run event shape, which happens to be Pi-shaped.

Each driver factory owns its process/session pool. Runs return `done`,
`abort`, `respondUi` and `pid`. Tests inject fake processes; production uses
real pipes, never a terminal emulator. No model is called by the test doubles.

The compatibility event shape is **not the archive format**. Do not mistake
an ignored UI event for an event absent from the native history. Native
plans, diffs, subagents, available tools, request provenance, richer dialogs,
account controls and unsupported operations need explicit handling before
release. Existing native session files remain the recording source.

Safety work covered by tests:

- Early abort does not submit a prompt after initialization.
- Concurrent sends do not change an active session's settings.
- Approval buttons belong to a specific active run and are single-use.
- Claude's broad/persistent permission suggestions are not forwarded by an
  ambiguously labelled 'allow for this conversation' button.
- A Codex stop without confirmed completion quarantines that thread instead
  of claiming it stopped or allowing another turn to collide with it.
- Different account environments cannot share one Codex driver instance.
- Guest-sandbox objects are rejected until native driver launching is wired
  through Chattering's actual OS sandbox.

Still required: integration with conversation ownership/recovery, Codex
indexing, harness-specific HTML controls, native request coverage, capability
negotiation, safe handoff and sandboxed identities. The current direct Claude
protocol versus official SDK choice must be reviewed before release.

## Tests

```sh
node --test test/pi-composer.test.js test/harness-composer-ui.test.js \
  test/pi-composer-real.test.js test/harness-composer-app.test.js \
  test/harness-events.test.js test/harness-drivers.test.js test/pisdk.test.js
```

The real Pi test uses isolated HOME/configuration and a fixture provider. It
checks a marker proving that completions, controls and reload made no model
requests. The browser test exercises actual HTML, HTTP, IPC and SDK code at
desktop and phone widths. Recorded native streams cover basic tool loops;
synthetic cases supplement them for cancellation, reasoning and failures.
