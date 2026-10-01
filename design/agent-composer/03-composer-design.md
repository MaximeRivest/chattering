# 3 · Adaptive composer: interaction and architecture specification

**Design proposal, October 1, 2026.** This describes the desired product, not shipped functionality. External interface evidence lives in `02-agent-evidence.md`; repository observations in `01-experience-audit.md`. `contract.ts` names the proposed application boundary. The prototype intentionally uses synthetic sessions and example catalogs.

## Promise

> Wherever I ask, I can see who will answer, where it will work, what I am sending, and what authority it has. Changing agents preserves my words and explains any change in context.

The main chat and file Ask are two layouts of one controller. A model-only utility (spelling, title generation, review-location suggestion) is a different execution profile, not a full agent session.

## A. What the person sees

### Resting box

- Main: destination above or beside the box when ambiguous; text; context chips; **agent · model** button; up to two relevant secondary controls; send.
- File Ask: **continues “conversation title”** is always visible, even with other options collapsed. File/line selection is a context chip. Review/apply remains an editor decision, not an agent permission setting.
- Keep the same corner shape, typography, spacing and send treatment throughout Chattering. No automatic scroll, palette replacement or textarea teardown when metadata arrives.
- Agent identity uses plain name and a small neutral mark. Optional accents must use theme tokens, remain low emphasis, and disappear without losing meaning in monochrome. Native terminology matters more than imitating a logo.
- A product/SDK display name may differ from the installed executable's name. Account and implementation details appear in the picker; they are not hidden behind a model label.

### Agent and model picker

One doorway, two meaningful dimensions—not a single flattened list of provider/model strings.

1. Search installed/configured agent connections, grouped by host/account when necessary.
2. Within a connection, show its own models and model roles. Current unlisted model remains visible with its ID and status, never silently replaced by a default label.
3. Selecting another model in the same agent shows **Applying…** until acknowledged. If it only takes effect next turn or after restart, say that.
4. Selecting another agent in an unsent new-conversation draft changes its intended destination after checking attachments; no native session is created just to draw the picker.
5. Selecting another agent in an existing conversation opens **Continue with [agent]**. The switch commits only after a transfer preview and confirmation. It does not send the typed message.
6. Show unavailable connections in an expandable **Other agents** section with a reason: not installed, signed out, unsupported version, wrong account, unavailable host, unsupported workspace or adapter not built. No installer or browser login starts on mere selection.
7. Model catalogs can be stale or not reflect entitlements. Show freshness; let a refusal explain itself; never silently reroute to another model, agent or paid account.

### Adaptive controls

A descriptor specifies native ID, label, description, type, ordered values, current value, semantic category, scope and when changes take effect. Support select, boolean and bounded scalar fields; unknown categories can render in More. Unknown types remain read-only with an explanation—do not synthesize defaults or claim the option changed.

Primary placement: model(s), then the highest-priority effort/mode control. More contains access, account, workspace, plugins/tool inventory, extra model roles, custom configuration and advanced operations. Agents may omit reasoning entirely. Aider-like main/editor/weak model roles must not be mistaken for parallel agents.

Settings have three states: requested, applying, acknowledged. Do not copy Pi's `high` to another agent just because the text matches; names do not guarantee semantics. Return to that destination's remembered settings or its acknowledged defaults.

**Scope language:** “this message”, “future turns in this session”, “this workspace”, “this account”. A permission escalation or persistent setting requires an explicit confirmation explaining its scope. An app review switch is not a sandbox.

### Input and context

- Text stays in the same editor instance while changing models, discovering metadata or moving panels.
- `@` provides host-authorized attachments and native completion where supported. `/` labels entries as **Chattering action**, **agent command**, **template** or **shell action**.
- Unknown commands block with an explanation; they are not forwarded as ordinary language on a guess. Executing a command is distinct from choosing a suggestion.
- Native insertion and cursor edits remain native. Completion tokens bind to actor, editor instance, destination generation, text revision, cursor and catalog revision.
- Attachments show origin and scope: file revision/selection, image, note, selected conversation history or project memory. Removing a chip removes it from the draft, not from previous turns already sent.
- Unsupported images/audio/files block Send or offer an explicit transformation/removal. Dictation is host-side text input; it is not evidence that an agent accepts audio blocks.
- File contents and imported history are data, not new high-priority instructions. Trusted host briefs and user instructions have distinct provenance. No foreign system prompt is promoted into developer instructions by default.
- A file Ask that saves before sending must verify the saved revision. Its queue entry preserves selection and brief. If the file changes before execution, hold for confirmation or rebuild a visible preview; never invisibly use a different file snapshot.

## B. Behavior by state

| State | What remains usable | Primary action / recovery |
|---|---|---|
| Discovering | Draft text, attachments, cancel | Send waits; “Checking this agent…”; no inference to test availability |
| Ready | Compatible controls | Send |
| Applying configuration | Draft stays editable | Send waits until acknowledged or rejected |
| Working | Draft and safe next-turn controls | Queue next, or explicit Steer if supported. Stop targets the named run |
| Waiting for approval | Draft kept; request card names agent/account/workspace | Native choices with literal persistence scope; cancelled/expired request cannot be approved |
| Queued | Queue preview, edit/cancel before launch | Shows destination/model/file revision; stop/error holds remaining queue |
| External owner | Read history and draft | “Open native app” or explicit takeover; no automatic key injection |
| Disconnected | Read cached history, edit local draft | Reconnect; never auto-send offline text |
| Delivery unknown | Keep submitted text and receipt | Check status, not a fresh retry; no exactly-once claim without native support |
| Configuration/destination changed elsewhere | Keep draft and submitted snapshot | Show what changed; refresh/reconfirm before send |
| Missing/sign-in/version/permission failure | Keep draft | Explain and offer allowed recovery; no credential fallback |
| Partial/incomplete result | Read what happened, inspect denied tools | “Finished with blocked actions”, not an unconditional success checkmark |

Run phase, connection state and submission state are separate state machines. A disconnected transport does not imply the run stopped. An HTTP/JSON-RPC acknowledgement does not necessarily mean the model finished.

## C. Handoff interaction

**Preview** shows source conversation/head, destination agent/account/host, workspace, and a transfer manifest:

- preserved user/assistant text and supported assets;
- tool steps converted to quoted historical records, never re-executed;
- summaries, omissions, missing files and provider-specific state;
- destination instructions/tools, permission baseline, approximate context size and any new charges where estimable;
- statement that project files are shared unless a separate workspace is deliberately chosen.

Do not promise exact token counts or cache behavior across providers. If the destination window is too small, offer a reviewed summary or a chosen history range; never silently truncate or auto-generate a paid summary.

**Commit** is prepare → validate → create/import target → verify → publish link. The source remains intact. A failed target creation/import cannot move the visible continuation. Keep a recoverable pending record with native target ID; retry must not create duplicate sessions. Final publication uses compare-and-swap against the source's selected continuation and policy revision.

V1 switching is allowed only while idle, with no pending approvals or unreviewed queued submissions. Explain why and let the person finish or stop explicitly. Stop confirmation is required; never switch away from an uncertain run.

Other composers bound to this conversation receive a new destination generation and retain their drafts. Their next send requires acknowledgement of the changed recipient. A separately targeted Ask box must not change at all. Shared drafts also need a recorded destination revision; a collaborator changing the agent does not authorize someone else's queued send.

**Back to Pi** after Pi → Codex is a new continuation carrying Codex's intervening work. It must not simply resume the old Pi session and forget that work. The logical conversation is a graph: previous segments/forks remain addressable; merges record multiple provenance parents. The list projects the selected continuation, not a destructive deduplication of history.

## D. Architecture boundaries

```text
Conversation box ─┐
File Ask box ─────┼─ ComposerController (one instance per box)
Review composer ─┘      │   explicit destination + versioned request
                        ▼
                 AgentCoordinator (server authority)
          policy · preparation · lease · queue · receipt · recovery
                   │                  │
             Session adapter     History reader/projector
            SDK / ACP / native   original records + evidence
                   │                  │
                  agent's native session / files / services
```

### Distinct identities

- **ConnectionRef:** installation, adapter/version, host, account/security scope and workspace. Account identifiers are opaque handles, never tokens in the browser.
- **ConversationRef:** stable logical conversation ID with selected graph head and generation.
- **SessionRef:** native harness/session ID, original source key, branch anchor and runtime incarnation.
- **ComposerRef:** mounted editor and draft ID, local/shared draft revision and attachment snapshot.
- **SubmissionRef:** actor-scoped idempotency key + full-envelope digest; binds an immutable attempted send to an eventual native turn.
- **RunRef / RequestRef:** owner-scoped identity allocated before native startup, including pending-session cases.

A session ID is not globally unique across hosts, accounts or native data directories. A raw path is not an authority token.

### Shared controller responsibilities

Own draft/input/cursor, local intent, selection, completion lifetimes, rendering state and submitted snapshot. Subscribe to destination state. Ask the coordinator for descriptors and send/prepare operations. Never access global `current`, global image lists, a global completion teardown, or a vendor executable.

Several controllers can target one session. They share acknowledged session configuration, run status and permissions through a session store, not through one another's textarea. Per-message choices remain per-draft. One panel unmounting disposes only its own listeners/queries. Dictation records the original editor ID; if it closes, retain a recoverable transcript instead of writing into the next focused box.

### Coordinator responsibilities

Authenticate first. Resolve authoritative destination; enforce account/workspace policy and budget; validate revisions/capabilities; reserve the session; allocate owner-bound run; prepare content; record accepted envelope; dispatch. Any awaited preparation requires a final validation under the lease. All entry points use this ordering, including drafts, Ask, reviews, voice and recovery.

Queue entries contain the whole immutable request, including brief, context hashes, requested configuration and origin. Revalidate authorization immediately before queued execution. Persist acceptance before reporting queued. A native timeout becomes unknown delivery until reconciled; do not blindly replay a potentially accepted tool-running prompt.

Approval references include installation, actor scope, session, run, native request ID and expiry. Respond once to the exact request and permitted option. Persistent approval is not labeled as a temporary one. Unsupported mandatory interaction blocks safely with a visible explanation.

### Adapter responsibilities

Keep discovery, lifecycle, configuration, prompt delivery, streaming, approvals, native commands and archive/history reading as separate optional interfaces. A read-only history adapter need not launch a process. An ACP adapter need not pretend it can parse a private archive. Pooling and lock rules belong to each native adapter; do not prescribe a single process topology.

Map native events to small typed display events while preserving native references and raw envelopes in access-controlled storage. Content redaction must be explicit. Cap storage and retention, protect secrets, and expose unknown event types as diagnostic evidence. Do not silently discard unknown mandatory requests.

Untrusted remote agents may supply structured data, not arbitrary executable HTML in Chattering. Specialized controls are shipped, reviewed components identified by an allowlisted renderer ID. A plugin with arbitrary UI execution needs a separate trust/install flow; not part of this refactor's first release.

### Capability resolution

Capabilities are **supported**, **unsupported**, **blocked**, **unknown**, or **requires restart**, with a reason and evidence revision. Resolution intersects adapter implementation, native version/handshake, principal/account, workspace policy, native session generation, selected models/modalities and current run state.

Transport capabilities and host policy are separate. Do not advertise steering because the CLI has a queue, or file review because it can print a patch. Distinguish reported tools from tools the host can intercept. Retain native config categories/IDs where available (ACP), but use typed application semantics for scope/effect/approval safety.

## E. Branding, responsive layout and accessibility

- Default geometry follows Chattering, not a vendor terminal. The prototype uses standard MCP Apps theme variables with fallbacks; monochrome is a first-class display, not a desaturated afterthought.
- Main and compact variants share the exact controller and control renderer. At narrow widths, move secondary controls into More; **never hide the agent name or destination to save space**.
- Native buttons, selects, textarea, dialogs and fieldsets; accessible labels include agent, model and scope. Keyboard can reach every action. Escape closes popovers before affecting a run; Enter does not send while an IME composition is active.
- No focus stealing when a menu/catalog response arrives. Closing dialogs returns focus to their own trigger. Arrow navigation/search in custom pickers follows standard patterns; native controls are preferred when adequate.
- Target at least 44px touch hit areas, visible focus outlines and WCAG AA text contrast. Reductions in motion must suppress animated transitions; e-ink uses no shimmer/blink or color-only meaning.
- Status announcements are polite and debounced; approvals/errors are concise and actionable, not a live region for every token.
- Product branding rules may constrain display names and logos. The design intentionally uses plain text/neutral marks; final approved asset use remains a release gate.

## F. Tests and rollout gates

The following are **acceptance requirements**, not a claim they already pass in production. Prototype checks are enumerated separately in `verification.md`.

- T01–T17: close the corresponding audit findings; add regression tests at the coordinator and UI boundaries, not source-string assertions alone.
- T18: same-envelope retry resolves one acceptance; changed envelope with same key rejects; actor isolation; process restart; native uncertain delivery does not cause a second inference.
- T19: Pi → Codex → Pi preserves selected visible history and provenance; failed import leaves source selected; concurrent tab commits reject stale source revision.
- T20: user text/tool output containing instructions remains imported data; native calls are never replayed; signed/encrypted reasoning not copied by company-name guess.
- T21: images, missing assets, too-large history, summary consent, changed file and denied account are visible blockers or explicitly approved transformations.
- T22: unknown config field safely displayed/read-only; unknown request visibly refused; retired model remains honestly labeled.
- T23: no automatic installation, login, paid probe or permission escalation on opening a chooser.
- T24: desktop, 390px phone, 320px narrow layout, 200% zoom, dark, monochrome, reduced motion, keyboard/IME, two boxes and screen-reader review.
- T25: external terminal lock/takeover; remote disconnection; wrong-host paths; native CLI exit 0 with denied tools; foreground completion with still-running background workers.
- T26: pinned native/ACP versions pass adapter fixtures and explicit live-budget smoke tests before changing the tested-version badge.

**Incremental rollout:** characterize existing Pi behavior → coordinator preflight/queue seams → instance-based main composer → compact Ask/review reuse → versioned descriptors/native adapters → switch preparation and graph links. Run old and new projections side by side read-only while validating; never dual-dispatch a send. Keep an explicit per-surface rollback switch.

## G. Rejected shortcuts and costs

- **Universal PTY scraping:** looks broadly compatible but does not reliably express approvals, ownership, effective configuration or receipt recovery. Keep it a named fallback only.
- **Force every harness into Pi events/files:** easy today, lossy and misleading tomorrow. Use display projections plus native evidence.
- **One giant generic settings form:** handles fields but loses hierarchy and agent-specific workflows. Use a compact shared core plus typed, trusted extensions.
- **ACP for absolutely everything:** would hide useful native functionality and archive access. ACP is a transport family, not our entire product data model.
- **One flat chain:** cannot preserve branches/merges. Use a graph and a simple selected-continuation projection.
- **Implicit handoff on model selection:** saves a click but surprises the person about account, instructions, tools and context. Confirm cross-agent changes.
- **Silent summary or model fallback:** hides loss/cost. Offer explicit alternatives and keep the draft.
- **Exactly-once promise over an uncertain native connection:** not generally possible. Persist intent/receipts and reconcile; require confirmation if delivery cannot be established.

## Done for steps 1–3; open for implementation

The architecture, surface coverage, state rules and visual interaction are specified. Native credential policy, version pairing, real history transfer, unknown request handlers, durable storage and OS-level isolation still need implementation and tests. The interactive prototype proves selected UI/state rules only; it is intentionally not an adapter framework smuggled into production.
