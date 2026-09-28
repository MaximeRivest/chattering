# Delegated conversations

## Model

A delegation is an assignment to a new, independent Pi conversation. It is not a fork, an alternative answer, or a message-tree branch.

Each assignment records:

- Its parent conversation and exact launch entry.
- Its own saved conversation.
- Its parent assignment, when a worker delegates again.
- Its task, role, model, reasoning level, prompt, tools, and mode snapshot.
- Its execution outcome and separate review decision.
- Its output directory, logs, process identity, and control requests.

The assignment ID identifies one attempt. A retry creates a new ID and retains `retryOf`. The original attempt never changes into its retry. Tree packages carry their raw entry references, so a launch remains findable inside grouped work or replies. Delegation anchors pin any model-comparison backing files that contain them; automatic fanout cleanup must not orphan their callbacks or parent links.

Do not infer delegation from a working directory, a process parent, a title, or timing. Older unmanaged agents remain untracked. This avoids false family relationships.

## Views

Reuse three existing surfaces:

1. **Transcript (parent):** each `delegate` call is a card under its step group: one collapsed line (`↳ title · model · state · time · steps · files · verdict`). Open it for the worker's final words, the brief (rendered), the records (paths, tools, log tail on request), and cancel or pause. The raw call stays inside the step fold. The runner's return is a quiet `↩ N delegated results returned` bar with the raw event one click away. The live strip above the composer says `↳ N delegated running` while the parent waits.
2. **Transcript (child):** one `↰ delegated by <parent>` line at the top, with role, state, and the parent's verdict. It leads to the exact launch line (the card). While a worker owns the conversation, the line says so and offers cancel.
3. **Agents:** group delegated work by its origin, with expandable descendants. Do not show the same managed process again as an unrelated background agent.
4. **Tree:** a delegated conversation is a dashed node under the entry that launched it; its own delegations hang under it. Dotted edges, a column of their own, never the `here` marker. The bar offers open and cancel only.

Vocabulary on these surfaces is plain: `running`, `done`, `failed`, `lost`, `cancelled`, `needs review`, `accepted`, `rejected`. Internal names (delivery, supervision, mode hash, notification state) appear only inside the records fold or as a warning when something is broken.

Read, continue, branch, fork, and multimodel merge keep their existing meanings. Delegation links never receive branch or fork actions.

Use native buttons and expandable groups. Patch their contents in place. Preserve focus, expansion, drafts, and scroll. Load logs only on request. Use text and shapes, not colour or animation, for state.

The task's initial prompt comes from its parent, not directly from the user. Label that provenance. Do not mine it as human project intent.

## Execution and review

Execution states are `starting`, `running`, `succeeded`, `failed`, `cancelled`, and `lost`. A planned state is available to clients.

Review states are `unreviewed`, `accepted`, and `rejected`. A parent review is not a human vouch. A zero exit code is not enough to accept work.

A process that disappears without a recorded outcome becomes `lost`. Do not restart it automatically. Its side effects may already exist.

Model message errors describe individual attempts, not settled worker outcomes. Pi owns the retry policy. The supervisor records retry events but does not signal a worker for a model message error. A later successful response clears that attempt error. Final failure still requires a failed result, exhausted retries, invalid verification, or an abnormal worker exit. Extension failures remain fatal even if later messages succeed.

Do not replay the historical `agent_end.messages` array after consuming `message_end` events. Old JSON printers that only supply `agent_end` remain supported. Let normal worker exit drain stdout before publishing the terminal state. Signal events record the reason and whether the owned process group received the signal. No automatic whole-task replay is implied by model retries.

The one-megabyte record bound still applies. Modern Pi duplicates run history in `agent_end`; after individual message events, an oversize canonical aggregate is skipped and counted separately. The raw log remains intact. Individual messages, unknown records, aggregate-only legacy output, and saved transcript verification keep strict limits. This trades validation of redundant aggregate content for bounded memory, without discarding authoritative message failures.

## Controls

- **Stop response:** stop the current web model turn only.
- **Pause new descendants:** refuse new child launches under this assignment. Existing workers continue.
- **Resume new descendants:** clear this assignment's pause. An ancestor pause still applies.
- **Cancel subtree:** persist a cancellation request for the assignment and its descendants. Completed files remain saved.

Cancellation is monotonic. Resume does not undo it. The supervisor, not the browser, signals its owned process group. Check process start identity and boot identity before using a saved PID.

Prompt write scopes are advisory. These processes retain the user's filesystem permissions. Process isolation prevents shared JavaScript state; it is not a security sandbox. Use disjoint worktrees or output directories for parallel writers.

## Runtime boundary

`pisdk.js` is the web host proxy. Each warm SDK session runs in a separate process, using `pisdk-worker.js` and `pisdk-runtime.js`.

This isolates extension environment variables. It also preserves SDK extension UI support without returning to terminal emulation.

Events remain subscribed outside explicit prompts. If an extension starts an idle turn, the host creates a normal tracked web run before forwarding its first event. That run must stream, expose stop controls, and settle like a user-started run.

Pi's direct custom-message API skips normal prompt preparation. `pisdk-custom.js` runs the public extension preparation hooks before idle custom turns. It preserves mode and context without adding a false user message. One checked internal SDK slot retains that prepared prompt across retries and compaction. The adapter fails closed when that capability changes. Real SDK fixture tests cover cold callback mode restoration.

Warm web sessions still stop with the web service. Detached delegation supervisors have a different lifetime. On systemd, place them in separate user scopes. `setsid` alone does not escape a service cgroup.

## Storage and delivery

Durable records live under `~/.local/share/chattering/delegations`. They are not disposable cache files. Saved worker sessions live under `~/.pi/agent/sessions/--delegated--` with their real working directory in each header.

`delegation.js` validates and launches. `delegation-supervisor.js` owns each process. `extensions/delegation.ts` exposes the runner to Pi. The web host supplies this extension explicitly, as do child launches.

`server-delegations.js` reads execution records and coordinates web callbacks. It does not signal worker PIDs or edit transcript ancestry.

Callback rules:

- Group results that return close together into one attention point: a result waits until no other sibling returned for 60 seconds, and never more than 3 minutes after the first. It never waits for a sibling that is still running: one hung worker must not hold back finished ones (on 2026-09-28 a stuck TypeScript builder hid three finished builders and then six finished reviews from their orchestrator for hours). When nothing else is running there is nothing to wait for, and the result goes at once. The callback lists the siblings still running, with how long and when they last spoke.
- Do not deliver while another writer owns the parent.
- Do not resume an abandoned branch automatically.
- Persist delivery intent before requesting a model turn.
- Give the callback a stable ID in an honest Pi custom message.
- After a crash, inspect the saved message before delivering it again.
- Treat delivery as delivery, not successful review or acceptance.
- Cancelled work must not restart the orchestrator.

Terminal roots use a next-turn review reminder. They do not receive automatic background model turns from this new runner. Web roots can receive tracked callbacks. Nested assignments inherit their recorded root delivery policy.

Each web parent also receives, at the start of a turn and only when it changed, one context line (`delegation-status`, not shown in the transcript) naming its children that are running or returned but not reviewed, read from the durable records. The tools tell the model to call `delegation_status` before it states any delegation's state: callbacks can be delayed, and it once told the user none of four builders had finished when three had.

## Quiet work

Long work is fine; silence is the signal. Nothing here ever stops anything.

A worker whose output has not moved for settings → quiet work (`quietMinutes`, default 20, 0 off) is quiet. Output is its JSON event log and its session file, whichever moved last; a web run's is its live event stream. A run waiting on a dialog is waiting for the person, not quiet.

Who hears:

- The conversation that launched the worker, when an agent turn can start there: a `delegation-attention` runner event (or, when a result is due in the same pass, the quiet facts inside that result's callback: one turn, not two). It says what the worker waits on (the open tool call), what the processes under it are doing (lifetime, processor time, pid, "idle" under 1% of one core), and where its log and session are, and leaves the decision to the parent: wait, look, stop only the stuck process, or cancel and later continue.
- The person, when no agent can be told: a terminal parent, a parent a terminal owns, one not indexed, a lost or cancelled parent worker, a moved branch, a paused subtree, a parent whose turn failed (out of usage, no model), and every web run (a person's own conversation has no agent above it). The row says "quiet", its dots stop, the phone notifies on its own channel, and this machine plays the attention tone unless finish sounds are off or muted.
- A busy parent is not skipped: it hears when its turn ends. If it is itself stuck, its own quiet check reports it.

Reminders come at 1, 3, 9, then every 9 times the threshold while the work stays quiet; new output starts the count over. A host down across several levels sends one reminder, not a burst. Reminder records live under `delegations/attention`; each reminder has a stable delivery ID in the transcript, so a restarted host does not repeat it.

Trade-offs: each reminder to an agent is a model turn; a legitimately silent step (a long download, a model thinking for half an hour) is reported too, with facts that show it is working. Processor time on Linux assumes the kernel's 100 ticks per second (Node cannot ask); Windows reports processes as unknown rather than guess.

The legacy inbox remains a compatibility path. New managed delegations do not depend on its process-global callback address.

## APIs

- `GET /api/delegations`: compact task snapshot, revision, and listing limits.
- `GET /api/delegations/detail?id=…`: saved prompt, mode contract, and bounded log tail.
- `POST /api/delegations/control`: `{id, action}` for pause, resume, or cancellation.
- SSE `delegation-update`: invalidate compact data, not full logs.

Use the existing local/LAN authentication boundary. Never expose launch environment values through these endpoints.

## Trade-offs

- A process per warm web session uses more memory and has a slower cold start. It prevents cross-session extension state errors.
- Separate user scopes add systemd integration on Linux. They give delegated processes a lifetime independent of a web-service restart.
- Saved worker conversations use more disk than ephemeral print workers. They provide readable history, file links, costs, and provenance.
- Explicit registration leaves old unmanaged processes unassociated. Guessing would create false provenance.
- A labelled panel in the tree is less compact than drawing every relationship as a tree edge. It preserves the meaning of message ancestry.
- Delegation anchors retain comparison backing files. This uses more disk, but keeps parent identity and callback targets valid.
- Custom turn preparation needs one checked SDK compatibility slot. This preserves mode fidelity now, but requires validation after Pi updates.
- Branch-safe callbacks can wait for user action. They must not move the continuation marker silently.
- Bounded snapshots and log previews keep the interface responsive. Show limits and keep full files available.
- No filesystem sandbox is claimed. This avoids misleading permission controls, but requires deliberate parallel write scopes.

## Acceptance gates

Test at least:

- Concurrent web sessions with different modes and callback identities.
- Idle extension callbacks, early abort, child crashes, and session disposal.
- Sibling callbacks, nested delegation, duplicate delivery, and branch changes.
- Supervisor launch failure, quiet workers, cancellation, and reused PIDs.
- A service-independent supervisor cgroup on systemd.
- Mode and tool contract mismatches before model work.
- A model error despite process exit zero.
- Recursive UI expansion, missing parents, cycles, hostile text, keyboard focus, and small screens.
- Unchanged branch/fork/fanout semantics and no draft or scroll loss.

Keep mechanical validation, review, repair, and acceptance separate in the implementation ledger.
