# 2 · Representative agents and protocols

**Checked October 1, 2026. Primary documentation, installed help/version output and local source inspection.** This is a design comparison, not a performance ranking. Documentation describes available interfaces; it does not certify our adapter or a particular account. No agent was installed, logged in, prompted, or given private history during this pass.

## Evidence levels

- **L — local:** executable help/version or Chattering source inspected here.
- **D — documented:** primary project documentation read today.
- **P — proposed:** Chattering design decision, not a vendor guarantee.
- **U — unverified:** needs an integration test, account confirmation or implementation.

## Installed snapshot

| Agent | Local observation | What was not done |
|---|---|---|
| Pi | Bundled `@earendil-works/pi-coding-agent` 0.87.1; SDK/CLI/RPC UI docs and session example read | No fresh model call or native handoff |
| Codex | `codex-cli 0.153.4`; existing app-server driver read | No new live transcript export/import or approval probe |
| Claude Code | 2.1.285; `--help`; existing direct-protocol prototype read | SDK package not installed or exercised |
| Antigravity | `agy` 1.2.14; `--help` | No auth state inspection, model call, or permission probe |
| OpenCode | Not on PATH | Docs only |
| Gemini CLI | Not on PATH | Docs/source documentation only |
| Aider | Not probed locally | Boundary-case documentation only |

Installed and online versions are independent. Feature tests must pin both transport/SDK and executable versions.

## Comparison and recommended transport

### Pi — embedded session with extensible editor (L)

Installed SDK documentation exposes session creation, persistent entry trees, runtime replacement, prompt/steer/follow-up and `agent_settled`. RPC exposes dialogs but documents degraded TUI-only features, including autocomplete-provider registration. Our SDK worker supplies additional composer bindings that the plain RPC interface does not.

**P:** retain the SDK worker adapter and RPC compatibility fallback as distinct execution profiles. Preserve provider-owned completion edits and rebind subscriptions after session replacement. Discovery that loads trusted extensions can have side effects; do not call it merely to paint a blank composer.

**U:** instance-isolated custom UI, typed shared-draft ownership, and uniform preflight across all entry points.

Local sources: bundled `docs/sdk.md`, `docs/cli-integration.md`, `docs/rpc-extension-ui.md`, `examples/sdk/11-sessions.ts`; `pisdk-runtime.js`, `pisdk-worker.js`, `harness/pi-composer.js`.

### Codex — native application server (D, L)

The app-server documents threads/turns, model discovery, streamed items, interruption and server approval requests. `turn/steer` targets an expected active turn and cannot apply turn-level overrides. Current documentation separates stable and opt-in experimental APIs; older blanket descriptions of the entire API as experimental are misleading. [R01]

**P:** retain native app-server transport; pin the installed schema and gate experimental import/fork behavior separately. Archive original events alongside UI projections. Queue-with-new-configuration is not steering.

**U:** native history import with mixed tools/images, runtime-version compatibility and reliable recovery across app-server restarts. Current Chattering uses per-conversation processes, not the shared process described in the old design note.

OpenAI's separate app-server sign-in guidance warns that `model/list` can be a bundled catalog under that configuration, rather than proving account entitlement. **P:** record catalog freshness and authentication scope independently. [R02]

### Claude Code / Claude Agent — SDK-controlled process (D, L)

The SDK exposes the agent loop, sessions, hooks and subagents. Its guidance prefers “Claude Agent” for integration menus and prohibits mimicking Claude Code's branding in SDK products. It also restricts offering claude.ai login/limits without prior approval. [R03]

Permissions involve native modes, rules, hooks and callbacks; not every tool reaches a callback. A universal “ask before everything” label would be false without the corresponding enforced policy. [R04]

**P:** evaluate the official SDK before maintaining the prototype's private control protocol. The SDK changelog documents custom executable-path support; avoiding a second bundled binary is not by itself a reason to reject the SDK. [R05]

**U:** exact SDK/CLI pairing, settings discovery, model-change lifetime, subscription/account eligibility and native-history loading. Keep local CLI observation distinct from product authorization.

### OpenCode — choose native server or ACP explicitly (D)

Official docs describe HTTP session endpoints, status, abort, history/fork operations and permission responses; server authentication is configurable. OpenCode also ships `opencode acp` over stdio JSON-RPC. [R06, R07]

**P:** ACP is the first interactive-composer candidate; evaluate native server for archive/history and features missing in the selected ACP version. Do not attach two simultaneous writers to one session just because both transports exist. Keep server credentials and transport behind Chattering, never directly in browser JavaScript.

**U:** parity between the two transports, multi-workspace routing, reconnect/replay, tool-question forms and model catalog updates. No runtime was installed to test those claims.

### Gemini CLI — native ACP with version-sensitive interface (D)

The upstream ACP guide describes stdio, session creation/load, prompts, cancellation, approval-mode control and model selection. Its configuration/reference pages disagree on `--acp` versus older experimental naming, so the adapter must inspect the installed release rather than assume one flag. [R08, R09]

Google's transition announcement moved consumer subscription access on June 18, 2026, while preserving enterprise access and paid API-key routes. “Enterprise only” is therefore too broad. [R10]

**P:** native ACP candidate, with account eligibility checked before advertising readiness.

**U:** installed handshake, supported ACP version/config options, question/approval semantics, local archive access and actual account route. Do not equate Gemini CLI with Antigravity.

### Antigravity (`agy`) — structured headless mode is not a complete client protocol (D, L)

Official headless docs describe NDJSON progress and stdin user messages, conversation continuation and per-turn result events. They warn that slash commands such as `/model` disrupt the stream; tools needing unavailable approval may be soft-denied while the process exits 0. Usage counters can be cumulative. [R11]

Installed help additionally exposes agent/model/effort, plan/accept-edits mode, sandbox and conversation options. [L: local help]

**P:** honest headless tier first. Surface tool denials as incomplete work. Offer native-app handoff for unsupported interactions; never enable `--dangerously-skip-permissions` merely to make automation work.

**U:** a documented, tested bidirectional approval/interrupt interface equivalent to ACP was not established. “Request permission” appearing in a tool list does not establish a client response mechanism. Subagent identity, artifact events and configuration persistence still need fixtures.

### Aider — useful counterexample to “one agent, one model” (D)

Aider documents command-line scripting, configurable automatic commits, and a Python scripting interface explicitly described as unsupported. Its commands distinguish main, editor and weak models. [R12, R13]

**P:** allow multiple model roles and Git side-effect controls in the descriptor. Do not imply the generic dropdown means side-by-side answers. A scripting adapter is not full interactive parity.

**U:** durable session/approval transport and integration-grade event fidelity. Avoid dependence on an unstable internal Python API without a deliberate compatibility budget.

## ACP: reuse, but negotiate versions

ACP v1 configuration options already supply identifiers, native names, current values, option order and semantic categories. Categories aid layout but are not required for correctness; unknown categories must not break the UI. Setting a value yields the agent's current configuration, which should be the displayed truth. [R14]

The v2 migration guide changes a critical boundary: prompt response acknowledges acceptance; completion arrives through state updates. It also removes the v1 client filesystem/terminal APIs and describes v2 as draft overall. **P:** v1 and v2 require separate negotiated codecs; keep v2 opt-in until tested. Do not infer a finished run from a successful JSON-RPC response. [R15]

Initialization, session loading and permission protocols are useful shared infrastructure, not proof of cross-agent history migration. Client-provided filesystem/terminal capabilities in v1 grant real authority and must be mediated by the host. Permission option IDs and persistence scopes must remain native. [R16–R18]

The ACP registry publishes installable agent metadata and authentication handshake checks. **P:** use it for discovery, not as a blanket certification of every operation or permission model. Installation still requires explicit consent and pinned provenance. [R19]

## Authentication and naming discrepancy to resolve before release

Anthropic's SDK overview restricts third-party subscription-login offerings. Its Help Center has a **June 15, 2026 update** pausing a planned usage change and saying SDK, print-mode and third-party app usage still draws from subscription limits. These pages answer partly different questions: technical billing behavior versus permission to offer an integration. Neither alone settles our product's eligibility. [R03, R20]

**Decision:** do not advertise universal subscription compatibility. Prefer a supported API-key route for an SDK product pending clarification; identify the actual account/backend and expose usage only when reported. This is a release gate, not legal advice or a claim that all local CLI use is prohibited.

## Treatment of the supplied twenty-agent list

We did not use tiers, stars, benchmark numbers or assumed context windows as design evidence. Seven representative agents above exercise the key architectural differences.

- DeepSeek Harness is documented by DeepSeek as a rapidly evolving plugin-based developer preview. Candidate for a later composable-runtime adapter, not an excuse to load arbitrary plugins into Chattering. [R21]
- Claw Code's canonical repository currently cautions that it is an exhibit and explicitly says it does not ship a working ACP daemon. Do not infer support from an `acp` command returning exit 0. [R22]
- A primary CodeWhale repository was found; its runtime contract was not reviewed deeply enough to promise integration. [R23]
- Cognition documents **Devin CLI**. The exact supplied label “Devin Fusion CLI” was not established as the integration name. [R24]
- Cursor CLI, GitHub Copilot CLI, Hermes, Cline, OpenHands, Kilo, Goose, Mistral Vibe and Kiro remain the expansion backlog. No claim of integration readiness or feature parity is made for them in this pass.

## Verification before promoting an adapter

For each exact version/account/host combination: discover without a prompt; create disposable session; one text turn; one real approval deny/allow; interruption including disconnect; model/mode change acknowledgement; multimodal compatibility; resume; two sessions at once; native history read; malformed/unknown event; credential isolation; tool denial distinguished from success. Then test handoff independently—never infer it from ordinary resume.

Use tiny synthetic conversations and disposable files. Live calls require an explicit cost budget and safe workspace. These gates belong to implementation/testing steps 4–6; they are not represented as completed research results.

## Primary sources (checked October 1, 2026)

Source URLs are recorded literally for reproducibility. Most describe moving current documentation, not the installed version; adapter tests must retain a versioned schema.

| Ref | Source | URL |
|---|---|---|
| R01 | OpenAI Codex App Server (redirects to official ChatGPT Learn) | `https://developers.openai.com/codex/app-server/` |
| R02 | OpenAI app-server sign-in integration | `https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server` |
| R03 | Anthropic SDK overview, authentication and branding guidance | `https://code.claude.com/docs/en/agent-sdk/overview` |
| R04 | Anthropic SDK permissions | `https://code.claude.com/docs/en/agent-sdk/permissions` |
| R05 | Official SDK changelog | `https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md` |
| R06 | OpenCode server | `https://opencode.ai/docs/server/` |
| R07 | OpenCode ACP | `https://opencode.ai/docs/acp/` |
| R08 | Google Gemini CLI ACP guide | `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/acp-mode.md` |
| R09 | Google Gemini CLI configuration/reference | `https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md` ; `https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md` |
| R10 | Google's account transition announcement | `https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/` |
| R11 | Google Antigravity headless mode | `https://antigravity.google/docs/cli/headless/` |
| R12 | Aider scripting | `https://aider.chat/docs/scripting.html` |
| R13 | Aider command/model roles | `https://aider.chat/docs/usage/commands.html` |
| R14 | ACP v1 session configuration | `https://agentclientprotocol.com/protocol/v1/session-config-options` |
| R15 | ACP v2 migration guide | `https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx` |
| R16 | ACP v1 initialization | `https://agentclientprotocol.com/protocol/v1/initialization` |
| R17 | ACP v1 session setup | `https://agentclientprotocol.com/protocol/v1/session-setup` |
| R18 | ACP v1 tool calls / permissions | `https://agentclientprotocol.com/protocol/v1/tool-calls` |
| R19 | ACP registry maintainers | `https://github.com/agentclientprotocol/registry/blob/main/README.md` |
| R20 | Claude Help Center, paused billing change | `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan` |
| R21 | DeepSeek developer preview and upstream repository | `https://www.deepseek.com/harness/en/` ; `https://github.com/deepseek-ai/deepseek-harness` |
| R22 | Claw Code canonical repository | `https://github.com/ultraworkers/claw-code` |
| R23 | CodeWhale repository | `https://github.com/zhuowp/CodeWhale` |
| R24 | Cognition Devin CLI | `https://cognition.com/blog/devin-for-terminal` |

Retrieval caveat: the DeepSeek landing-page open returned “Page moved”; its indexed primary page and upstream repository supplied the developer-preview evidence. Exact SDK TypeScript signatures were not exhaustively validated and remain a build-time verification item. Source pages can change independently of installed releases.
