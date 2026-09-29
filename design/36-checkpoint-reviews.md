# Checkpoint-backed change reviews

## Delivered flow

A transcript tool group now has a **Review changes** button. The old filename
count is labelled **files touched**: several edits can cancel out, and Bash can
change files that transcript mining did not discover. The review's net file list
comes from its recorded before/after checkpoint pair, not that filename count.

A review is immutable as a file comparison. It offers:

- Combined changes or an individual captured tool step.
- One compact review header: a scope selector, a file picker, View options, and
  Review. Layout, expand/collapse, and detailed capture notes live under View;
  capture gaps remain visible. File actions are small icons in the file header.
- Read either recorded version without writing to disk.
- Edit the live file in the existing workspace, with a return-to-review button.
- File/general comments and line-range comments bound to the exact side, blob,
  checkpoint pair, line range, quoted selection and surrounding code.
- Line comments and their editor sit directly after the selected line/range on
  the matching before/after side. File comments stay beneath the file header;
  only general comments appear in the general section. Replacement lines align
  side by side, and unchanged context is expandable rather than always visible.
  Commented ranges remain visible. In unified mode both sides' comments remain
  visible, and unchanged lines retain both old/new line numbers.
- A comment appears inline in another step only if its saved blob and quoted
  range match exactly. Otherwise it stays in a labelled context section with an
  Open context link, never attached to a different line. Resolved comments and
  suggested replacements are collapsed by default.
- Optional suggested replacement text, never automatically applied.
- Explicit reviewed-file state and resolved/unresolved comments.
- Server-persisted comments and review status; unsaved typing stays in this
  browser session. Reopen a review to see saved changes from another device.
- A preview of the exact message sent to an existing Pi conversation in the
  same project. Unresolved comments, suggestions, pinned code context, private
  Git reference information, and bounded live differences are included.
- Review-linked follow-up groups link back to the original review and can be
  compared as follow-up-only or original-plus-follow-up. The relationship is
  recorded when a generated `Review <id>` message starts a captured run.

## Capture architecture

`checkpoint-extension.js` is an inline Pi extension installed by
`pisdk-runtime.js` in chattering-managed SDK workers. It registers awaited
`before_agent_start`, `tool_call`, `tool_result`, `agent_settled`, and shutdown
handlers. It does not wrap or replace tool implementations, change their inputs,
change results, or write messages into the transcript.

Known **built-in** read/ls/find/grep tools skip per-tool capture. Overrides and
unknown/custom tools are conservative: they are captured, as are write/edit/bash.
Failed tools get after-error checkpoints. Incomplete/blocked tools are labelled
incomplete at settlement rather than assigned invented completion boundaries.
Capture errors warn and leave coverage gaps without blocking tool execution.

Do not replace the awaited hooks with a `session.subscribe()` observer: that
would race the tool and could not guarantee a before boundary.

Editor saves and watched filesystem changes also schedule debounced checkpoints
through the server. They do not depend on an agent naming the changed file.
Existing per-file history is retained rather than destructively migrated.

## Storage and concurrency

`checkpoint-store.js` owns private bare Git repositories and SQLite metadata
under `~/.local/share/chattering/checkpoints/` (`CHATTERING_CHECKPOINT_DIR` overrides it).
Directories and metadata are owner-only. This store is outside project folders
and the rebuildable activity cache. Back up the complete store while writers
are stopped; a raw copy of a live SQLite database alone is not a consistent backup.

- The working repository's index, branches, HEAD and history are never mutated.
- Each scan has an independent temporary Git index. Raw blob contents bypass
  clean filters and line-ending conversion. Hooks and fsmonitor are disabled.
- Private ref updates use compare-and-swap, so separate workers can publish
  concurrently without losing the private commit chain.
- Immutable snapshot identities include the file manifest and exclusion markers.
  Unchanged snapshots reuse storage. Boundary records retain their own times,
  session, run, tool-call ID, phase, error and overlap information even when they
  reference the same snapshot. The SQLite boundary timeline—not Git commit
  timestamps—is the chronological UI source.
- Parallel tools remain parallel. Scans serialize within a store instance but
  never hold a lock across tool execution. Overlapping/incomplete intervals from
  other workers are detected conservatively; changes are never attributed solely
  to a tool just because they occurred during its interval.
- Content writes are synced before publication; metadata is stored with SQLite
  FULL synchronization. Git publication precedes the metadata pointer. A crash
  can leave unused objects or a gap, not an invented successful boundary.

## Deliberate limits / trade-offs

- These are workspace scans, not atomic filesystem snapshots. They cannot prove
  exclusive authorship or record every rapid write/background-process step.
- The checkpoint scope is the tool cwd's Git root, or that cwd for a non-Git
  workspace. Nested repositories are not recursively treated as one project.
  Known tool writes outside the root are reported as exclusions.
- Repository `.gitignore` rules apply to untracked files. Tracked files remain
  eligible. Dependency folders are skipped. Non-Git folders use the private Git
  index for ignore-aware enumeration; no `.git` is created in the workspace.
- Only regular UTF-8 text files up to 2 MiB are captured. Symlinks, binary,
  oversized and nested-repository entries are explicitly unavailable, never
  represented as empty files. Renames currently appear as deletion/addition.
- Scans cap at 20,000 candidate paths and 200 MiB of eligible file contents.
  The scan loop and individual Git commands have 15-second limits. Capturing
  before tools adds latency; stat/contents caching and snapshot deduplication
  reduce repeated work without interpreting Bash command strings.
- `CHATTERING_CHECKPOINT_MB` defaults to 1024 MiB for the whole store
  (repositories and metadata). Compaction and oldest-first removal keep it
  there; see design/81, which supersedes the earlier "no pruning" rule. Do
  not run arbitrary Git cleanup on the managed store: the metadata, not Git
  refs, decides what is kept.
- `CHATTERING_NO_CHECKPOINTS=1` disables automatic capture. Loose launch directories
  (home, `/tmp`, etc.) are not automatically scanned. Chattering-managed SDK sessions
  are instrumented; standalone terminal Pi/RPC/other agents are not automatically
  installed or intercepted. Their disk changes can be observed by the server.
- Copies can retain removed secrets. They are local and permission-restricted,
  not encrypted. The old per-file archive remains, so there is some duplicate
  storage until a deliberate migration is designed.
- Older conversations cannot gain retroactive checkpoints. A missing group pair
  shows an incomplete review, known filenames and available individual steps;
  it never substitutes today's files as the old group's result.
- Reviews freeze their endpoints. New changes require a new review/group.
  Comments are not silently reattached to moved lines; live drift is flagged.
  Comment revision/thread replies and automatic line remapping are not included.
- Large inline diffs (over 500,000 characters or 20,000 lines across both versions) fall back to
  recorded-file reading. Review messages cap at 150 KiB; live patches/context
  have explicit truncation notices. Suggestions are proposals, not one-click
  patches applied to potentially changed code.
- Review send uses a persisted one-time preview token. A retry/double-click
  cannot send the same token twice. If acceptance cannot be confirmed, delivery
  stays uncertain and requires checking the target conversation. This does not
  claim a distributed exactly-once guarantee across process crashes.
- The selected Pi conversation retains its existing active context/path and
  model. This flow does not secretly fork, rewind or take over a terminal agent.
- Arbitrary time-window/project-wide entry points into these new reviews are
  not yet wired; the delivered entry point is the conversation tool group.

## Files / APIs

- `checkpoint-store.js`: private snapshot objects and chronological boundaries.
- `checkpoint-extension.js`: awaited Pi capture hooks.
- `change-reviews.js`: pinned reviews, comments, status, preview/delivery state.
- `change-review-ui.js`, `change-review.css`: review interface.
- `conversation-reader.js`: group entry point; `server.js`: API and observation
  capture integration; `pisdk-runtime.js`: SDK registration.

`POST /api/reviews` selects tool-call IDs validated against the source transcript.
`GET /api/reviews?id=…[&step=…]`, `GET /api/reviews/file?id=…&path=…[&step=…]`.
POST suffixes: `/comment`, `/resolve`, `/mark`, `/prepare`, `/send`, `/combine`.
Clients cannot choose arbitrary object IDs or substitute file contents in a
review. File/line anchors are checked against the server's pinned versions.

## Verification

`test/checkpoints-review.test.js`: index/HEAD isolation, filenames including
newlines, modes, ignore policy, symlink/binary exclusions, deletion, pinning,
comments, live differences, one-time delivery and uncertainty, follow-up
comparisons, concurrent publication, non-Git workspaces, awaited hook ordering,
read-only-tool classification and failure isolation.

`test/pisdk-real.test.js` + probe fixtures: actual installed SDK processes and a
fixture model execute Bash; before/after hooks prove that a newly written file
is absent before and present after, without contacting a real provider.

`test/conversation-app.test.js`: Chromium opens a real transcript's group review,
loads the diff, saves a line comment/suggestion, reopens it, previews the exact
package, and checks phone layout alongside the existing Files/MRMD/history flow.
It also checks inline editor placement, saved comment placement, range movement
without losing draft text, unified layout visibility, file-level placement,
step switching and compact line height. `test/change-review-ui.test.js` verifies
replacement pairing, revealed comment context, exact-version anchoring, unified
line numbers, escaping, absent files and resolved-comment presentation.
