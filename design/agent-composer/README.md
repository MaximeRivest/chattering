# One conversation, the right agent

**Research and design package · October 1, 2026 · steps 1–3**

Status: experience audit, representative-agent research, and interaction design completed for review. **Not a production integration or certification of every CLI.** No production code is imported by the prototype. No real model requests, authentication, permission changes, session handoffs, or file edits occur in it.

## Read or try

- `01-experience-audit.md` — the complete audited surface map, concrete findings, evidence anchors, scope and exclusions.
- `02-agent-evidence.md` — verified primary-source comparison; local versions; transport decisions; uncertainties and verification gates.
- `03-composer-design.md` — interaction specification, controller boundaries, identity, safety and accessibility; migration and acceptance criteria.
- `index.html` — interactive two-composer design prototype. Select an agent; compare controls; try a handoff, approval, busy session, connection loss, restricted identity and stale settings. All outcomes are simulations.
- `contract.ts` — proposed application-level contract, not an implementation or a replacement for ACP.
- `model.mjs` / `model.test.mjs` — executable examples of the design's state rules.
- `browser-test.mjs` — isolated Chromium walkthrough, including narrow and monochrome views.
- `inventory.json` — reproducible source inventory with hashes and anchor locations.
- `verification.md` — what was actually tested in this pass, versus future acceptance tests.

## Decisions in plain language

1. **One composer engine, several layouts.** Chat and file Ask can coexist without reading each other's global state.
2. **Agent, model and account are separate choices.** A Claude model inside Pi is still Pi. An agent can expose multiple model roles, not necessarily one model.
3. **The destination determines the controls.** Capabilities belong to an installation, version, account, workspace and session—not just a product name.
4. **Use ACP where it fits; keep native adapters where they add necessary fidelity.** The common interface is inside Chattering. It does not require every agent to adopt a new protocol.
5. **Switching is an explicit, reversible-in-the-interface handoff, not file conversion in place.** Keep originals; create a new native segment; show the transfer report. Returning to an agent must include intervening history.
6. **Consistent Chattering design, modest identity.** Plain agent name and a restrained mark; no copied terminal chrome or mandatory vendor colors. SDK naming and account permissions must match the actual integration.
7. **No silent losses.** Unsupported attachments, missing instructions, unavailable controls, incomplete edits and uncertain delivery remain visible.

## Material changes from design/87

The earlier note mixes historical plans with implementation claims. This package supersedes its *proposed future architecture*, not its native files or implemented APIs. Important corrections:

- Current Codex driver source creates **one process per conversation**, plus a utility process, not the single shared process claimed in the note.
- The so-called owner gate rejects guest/sandboxed principals, not every non-owner. Unwalled household members can share the machine account; earlier assurances that all family accounts were excluded were incorrect.
- The current Codex queue drops `brief`. File-Ask integration is therefore not complete in the busy path.
- A static boolean capability table is insufficient.
- A conversation may branch and merge: the proposed session structure is a **graph with a selected continuation**, not a flat chain that erases alternatives.
- Textual “next request only” instructions do not enforce lifetime. Retained developer context stays retained.
- Do not promise identical messages/context across agents, fixed cache savings, or transferable hidden reasoning. Report the particular handoff's transformations.
- A shared event view must preserve native references and unknown events rather than making Pi's event format the permanent universal archive.

## Trade-offs

- The design adds a controller and a server coordinator rather than more per-agent UI conditions. More work initially; fewer divergent send paths later.
- An optional capability is visible only when safely known. Unsupported input blocks sending instead of being silently discarded.
- Native adapters preserve special behavior but need version-specific tests. ACP reduces duplication, not the need for those tests.
- Third-party naming, login and subscription behavior are release gates. A successful local CLI invocation is not product authorization.
- The prototype makes handoff mechanics inspectable with synthetic history; it does not prove native history transfer or remote recovery.

## Completion boundary

Steps 1–3 produce a reviewed map, a source-backed decision record and a testable design. Steps 4–7 still implement the adapters/coordinator, real handoffs, rollout and broader agent support. No claim of zero blind spots is made. The audit names remaining verification work rather than counting missing evidence as support.
