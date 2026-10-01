# 1 · Experience audit

**October 1, 2026. Static inspection of the working checkout, not just HEAD.** Source anchors below are searchable names; `inventory.json` records exact lines and SHA-256 hashes at capture time. Concurrent work and existing uncommitted edits are preserved. Prior conversation claims are not treated as proof.

## Method and boundary

1. Enumerated production calls into send/start/queue/fork/terminal/runtime operations and browser model/effort pickers, excluding vendored bundles, generated output, tests and design artifacts.
2. Read the controlling UI and server paths for each family below, plus lifecycle, approvals, collaboration and selected tests.
3. Compared Pi and Codex dispatch, context lifetime, identity, queue and completion behavior; inspected Claude's existing prototype.
4. Separated **observed source behavior**, **risk requiring a regression test**, and **proposed design**. This is not a penetration test, complete line-by-line server review, or runtime validation of every feature.

The scan is reproducible, not a proof of completeness. Indirect callbacks, native extensions and future plugins require the same integration checklist. Counts of `source === ...` are not a complexity metric or evidence of safety.

## Surface map

Every row is a feature family to preserve. A shared controller is required only for conversation-bound actions; bounded utility model calls should not accidentally acquire agent tools or user conversation history.

| ID | Person's action | Current entry point / ownership | Refactor obligation | Existing test family |
|---|---|---|---|---|
| S01 | Write in the main conversation | `app.html`: `agentComposerHtml`, `wireAgentComposer`, `/api/node/send`; `server.js`: `startAgentRun` | Explicit destination and draft snapshot; no late reads of `current`/`activeRel` after asynchronous work | `codex-app`, `codex-runs`, `conversation-api` |
| S02 | Start a new conversation | `conversation-draft.js`: `newDraft`, `draftAsCurrent`, `showDraft`; `server.js`: `startConversationFromDraft` | Configuration before session creation; account-scoped idempotent start; preserve text/images on failure | `conversation-draft`, `codex-runs` |
| S03 | Start in a project or area | `server.js`: `startProjectConversation`, project/area setup callers | Resolve host/workspace before model discovery; do not default every non-Claude agent to Pi | `project-create`, `project-setup-ui` |
| S04 | Ask about a file | `ask-bubble.js`: `askBubbleLoadTarget`, `askSubmit`; `server.js`: `filesAskResponse`, `filesAskCodex` | Same controller in compact layout; include exact file revision, selection, brief and explicit target | `ask-bubble`, `file-ask-api`, `codex-app` |
| S05 | Ask beside a conversation | `pair.js`: `withConversation`, `mountDocument`; `fileWs.besideKey` | Main box and file box can be mounted simultaneously, sharing session state but not draft text | `side-panel`, `codex-app` |
| S06 | Fix a failed notebook cell / set up an environment | `app.html`: `doc-fix-agent`, `doc-setup-agent`, Ask box calls | This is a file Ask with extra context, not a new Pi-only runner | `notebook-setup-app`, `ask-bubble` |
| S07 | Run a notebook cell | `app.html`: `docRunRequest`; `server.js`: `streamDocRun` | Keep kernel execution separate from an agent send; its error may seed S06 | notebook/runtime tests |
| S08 | Transform selected prose/code | `ai-commands.js`, document AI integration in `app.html` | Tool-less bounded transformation; share picker primitives only, not full session authority | `ai-commands` |
| S09 | Pick model(s) | `app.html`: `openModelPicker`, `renderModelStrip`; `codex-ui.js`: `choices`, `pickModel`; Ask picker | Agent + installation/account + model role + model ID, not provider/model alone; distinguish preference from effective model | `model-picker`, `codex-app` |
| S10 | Pick reasoning / mode / access | `showThinkingPicker`, `cycleThinking`, `convModes`; `codex-ui.js`: `pickEffort`, `pickAccess` | Per-session advertised controls; label scope and acknowledgement; never map all agents to one effort ladder | `pi-composer-real`, `codex-app` |
| S11 | Complete `/`, `@`, command arguments or extension triggers | `harness-composer-ui.js`: `createClient`, `install`; `harness/pi-composer.js`; `composeInPi` | One completion instance per box; bind snapshot to identity, destination and draft revision; distinguish startup side effects from metadata lookup | `harness-composer-ui`, `harness-composer-app`, `pi-composer` |
| S12 | Execute a command or insert a snippet | `harness/compose-commands.js`; `app.html` command dispatch and snippet globals | Classify local UI action / template / native command / shell action. Unknown slash command must not turn into an ordinary prompt | composer tests |
| S13 | Dictate into either box | `app.html`: `wireAgentSpeech`, `currentSpeechTarget`, `agentSpeechEvent` | Dictation owns a box ID from recording start to final result, even after navigation | `voice-app`, `voice-commands-app` |
| S14 | Spoken navigation/delegated search | `voice-actions.js`; `server.js`: `voiceDelegateStart` | Separate navigation automation from conversation continuation; currently hardcodes Pi start | `voice-actions`, `voice-api` |
| S15 | Reply by voice to a finished run | `server.js`: `voiceListen` | Bind reply to original run/destination, not last visible conversation or stale model string | voice tests |
| S16 | Read queued/running replies, stop or steer | `startAgentRun`; `harness/codex-runs.js`: `send`, `drive`; `runEventForwarder` | Explicit queue/steer semantics, durable request identity, confirmed stop versus unknown delivery | `harness-drivers`, `codex-runs`, `server-jobs` |
| S17 | Approve a tool / answer a question / use extension UI | `app.html`: `buildUiRequest`, `updateRunUi`; `/api/run/ui-response`, `/api/run/ui-input` | Preserve native option IDs/scopes; authorize by run owner even before native session key exists; arbitrary forms need a safe fallback | `harness-drivers`, extension tests |
| S18 | Retry, edit an old prompt, fork or continue earlier | `conversation-reader.js`: `regenerateQuestion`; `server.js`: `forkSession`, `forkSessionForEdit`, `branchSession`, `startRegenerate`; transcript editor | Native branch capability with granularity; handoff is distinct from editing a native transcript | `parallel-fork`, `transcript-branch-edit`, `codex-runs` |
| S19 | Compare parallel answers and merge them | `conversation-reader.js`: `openConversationMerge`; `startFanOut`, `startMerge`, `startAggregate` | Separate native branching from app orchestration. No multiple writers in one workspace by default | conversation/fan-out tests |
| S20 | Compact, attach context, change instructions | `writeAttachedContextFile`, `saveConversationContext`, compaction routes | Typed context parts, trust/lifetime labels and file hashes; compaction must not erase provenance | `context-panel`, `context-fill`, `codex-runs` |
| S21 | Open native terminal / take over | `openConversationInTerminal`, `sendToConversation`, `sendToAlacritty`, bridge files | Confirm ownership transfer; server-chosen executable; no live keystroke relay as universal transport | delegation/terminal tests |
| S22 | Send marked-up file or Git feedback | `sendFileFeedback`, `sendGitFileFeedback` | File feedback has Codex routing; Git feedback remains Pi/Claude choice. Both need explicit destination/account/workspace | file-feedback test paths |
| S23 | Review changes and send comments back | `change-review-ui.js`: `crPreview`; `/api/reviews/prepare`, `/api/reviews/send` | Prepared preview token bound to person, destination revision and file versions; revalidate at send | `change-review-ui`, `task-reviews` |
| S24 | See changed files, line history and authorship | `conversationDiffs`, `ledgerIngestConversation`, `step-changes.js`, `conversation-reviews.js` | Evidence levels: snapshots / recorded patch / inferred path / unknown. Do not treat tool labels as observed disk state | `codex-diffs`, review/ledger tests |
| S25 | Delegate work and receive callbacks | `server-delegations.js`; `delegationParentReach` and `customMessage` dispatch | Keep typed host actions outside ordinary prompts; unsupported adapter must refuse, not flatten lifecycle callbacks into text | `server-delegations`, `delegation-real` |
| S26 | Resume after interruption / reconnect | `server.js`: recovery launch, `captureInterruptedRun`, `restoreInterruptedRuns` | Delivery reconciliation before retry; cancelled, failed, incomplete and unknown are different outcomes | recovery/server-job tests |
| S27 | Write together / send shared draft | `people.js`: `composeShareAttach`, `composeShareCheck`; `collab-client.js`; `composeCoauthorsOf` | Shared text revision and destination generation; clear only submitted content, preserve concurrent edits | people/collab tests |
| S28 | Use another machine / mirror | `design/90`, `anywhere-link.js`, platform and mirror routes | Host is part of every reference; remote path is not local path; never silently fall back to local credentials | anywhere/link tests |
| S29 | Switch identity or sandbox | `policy.js`, `principalFor`, `principalInProject`, `assertPrincipalCanRun` | Central authorization before discovery/start/send/approve; invalidate account-scoped caches | policy/people/delegation tests |
| S30 | Configure background models, rewrite helpers, review-repair or programs | `app.html` auxiliary model pickers; `modelprocess.js`, `review-repair.js`, `ai-commands.js` | Utility execution profile: no automatic conversation creation/harness switching. Surface model billing separately | `modelprocess`, `ai-commands`, program tests |
| S31 | Read history/search/list/timeline | native readers, `conversation-reader.js`, `usageanalytics.js`, source marks | Canonical native keys remain resolvable; future conversation graph adds selected continuation without hiding forks or rewriting old citations | `codex-transcript`, `codex-server`, search/tree tests |
| S32 | Inspect account usage / missing install / update | `codex-ui.js`: `menusFor`, `paintLimits`; `codexInstalled`, model catalog | Discovery freshness and account/host scoping; quota percentages are not dollar costs or model entitlement guarantees | Codex menus/model tests |

## Concrete findings and design consequences

These are **not fixed in this research pass**. A green existing test suite does not close them.

| ID | Finding in inspected source | Confidence / impact | Required gate |
|---|---|---|---|
| F01 | `harness-composer-ui.js` stores module-global `uninstall`; every `install` calls the previous one | Observed; cannot independently install completion for two boxes | T01: two mounted boxes retain independent completion, cancellation and focus |
| F02 | `codex-ui.js` uses `current`, `activeRel`, `draftState`; Ask has a separate model/effort implementation | Observed duplication; async wrong-destination risk | T02/T03: destination identity captured before requests; stale menus ignored |
| F03 | Codex `send` accepts `brief`, but its `followUps.push(...)` does not retain it | Observed omission; busy Ask loses instructions | T04: queue the full envelope, including selected file revision and brief |
| F04 | Codex `drive.finish` drains its queue regardless of terminal result; enqueue lives only in a Map | Observed; stopping/error can be followed by more work; restart loses queue | T05: stop/error hold queue for explicit action; persistent acceptance receipts |
| F05 | `startAgentRun` returns through the Codex branch before Pi's under-lock `expectedLeaf`/`expectedVersion` checks; main box payload omits `expectedLeaf` | Observed structural discrepancy; not a demonstrated exploit | T06: one common preflight and revision check under destination lease |
| F06 | `/api/node/send` saves selected models before its explicit `assertCan`; route permits guest entry with body authorization later | Observed ordering; whether exploitable depends on surrounding policy | T07: authorization before mutation; negative authorization tests at every entry |
| F07 | New Codex jobs initially have null `key`; abort/approval routes check conversation permission only if a key exists | Observed authorization gap candidate; requires principal/session threat test | T08: allocate owner-bound run identity before launching anything |
| F08 | New Codex draft path returns before Pi's coauthor capture/shared-draft close path | Observed divergence | T09: acknowledge shared draft revision and coauthors identically across agents |
| F09 | `draftStarts` is keyed by draft ID; lookup does not check age, and the Codex branch returns before the expiry sweep in the Pi start path | Observed cache design risk, not proof of cross-user access | T10: actor-scoped idempotency key, request digest, expiry and restart handling |
| F10 | Codex `send` awaits context preparation before inserting `headlessRuns` record | Observed race window; native driver claims help but do not reserve orchestration | T11: reserve request before preparation; concurrent sends have one defined outcome |
| F11 | Review delivery calls `startAgentRun` without forwarding `principalFor(identity)` | Observed identity propagation risk | T12: caller identity must be mandatory all the way through dispatch |
| F12 | Codex menus cache scope is conversation/cwd, not explicit actor/account/version | Observed; invalidation responsibility currently implicit | T13: isolate caches and erase them on identity or installation change |
| F13 | `codexDiffs.outcomeOf` can infer applied from whole-shell exit 0; embedded patch text can be in a command that never applies it; no inherited-fork traversal in `conversationDiffs` | Observed evidence limitations | T14: distinguish requested patch from per-call result and observed filesystem changes; test inherited history |
| F14 | Codex diff operations record `movedFrom`, but server projection discards it; deletion becomes a shell event without previous bytes | Observed loss | T15: typed rename/delete evidence; no fabricated exact diff or undo |
| F15 | Slash, speech, shared-box and image state still have global owners | Observed; multi-box scope is broader than completion alone | T16: explicit editor lifetime and input session ownership |
| F16 | Existing note says one shared Codex process; `openThread` actually creates/retains per-thread servers | Observed documentation mismatch | Document native lifecycle as an adapter responsibility, not a universal pooling policy |
| F17 | Existing native-control projection has confirm/select/input/editor shapes but not arbitrary rich requests | Observed; protocol expansion risk | T17: unknown mandatory request fails visibly; never auto-approve or wait invisibly |
| F18 | Terminal process scanning recognizes Pi/Claude/bridge, not Codex | Observed; external ownership display incomplete | Native locking and external activity detection must be separately advertised |
| F19 | `assertOwner`/`codexRefused` reject guest/sandbox principals, but `principalFor` permits unwalled household members under the shared machine account | Observed; prior “family accounts cannot use Codex” assurance was incorrect | Name and enforce the actual account policy; test owner, unwalled member, walled member, guest and delegated callers separately |

## Retain, do not rewrite gratuitously

- `createClient` already rejects stale draft/completion replies and applies provider-owned edits. Keep those semantics; remove the global mounting owner.
- Pi worker isolation, scoped autocomplete snapshots, engine callbacks and exact edit operations are valuable tested seams.
- Existing run cards, file-review projections, transcript layout and shared-text binding should consume new controller/coordinator events, not be replaced wholesale.
- Keep original native records and their stable keys. Add a logical conversation ID above them for switching; old links still resolve.
- Existing staged review preview/delivery is a good model for handoff preview/commit, after identity and revision binding are made explicit.
- Keep `platform.js` as the source of path/executable/host semantics. New adapters must not repeat Unix-only PATH tests or resolve an unknown relative path against `/`.

## Deliberate exclusions

- No assertion of every security path being sound; F06/F07/F11/F19 specifically need negative tests before rollout.
- No new production tests or patches to close these findings in steps 1–3.
- No read of personal credential files, no subscription inference run, no real session migration, no process takeover, no service restart.
- No claim of full Codex edit attribution: shell side effects, partial scripts, renamed/deleted files and missing ancestors remain evidence-sensitive.
- The legacy PTY renderer remains a compatibility fallback. It is not the contract for new integrations.
