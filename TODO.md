# TODO

The big items, each with the job to be done, why it matters, what already exists, and where to look before starting. Pointers are files in this repo, `design/` notes, and past conversations (`chattering show <id>`). Records are AI transcripts and AI-written notes: a map of what was said, not verified truth.

Order is rough priority. Tick a box only when the workflow works on a real installation, not when tests pass (see `design/32` and the project memory: "passing tests and healthy HTTP endpoints do not establish a usable deployment").

---

## 1. A real browser inside the conversation (picture-in-picture, and tabs on the right)

- [ ] Streaming browser pane in the conversation view
- [ ] Human and agent share the same tab; a visible "you / agent" control switch
- [ ] Several panes → real tabs/windows on the right, one per page the agent is working on
- [ ] Phone and e-ink layouts (stacked, page-flip)
- [ ] Resize-to-fit: the pane's size drives the tab's viewport
- [ ] (Later, only if snapshots feel rough) GPU video + sound

**Job to be done.** While an agent works (the step group in the transcript: "19 steps · bash · chattering_show …"), the person wants to *see the actual web page* the agent is on, in a picture-in-picture next to the steps, and be able to click, type, scroll and log in themselves, then hand control back. Not a screenshot, not an iframe: the real Chromium with the real profile, so every site is fully featured and behaves exactly as for a direct visit.

**Why.** Today `agent_browser` drives a real Chromium (private CDP pipe, real profile, trusted input, `navigator.webdriver` false) but the person cannot watch or take over from inside Chattering; they must be sitting at that machine. The pane is what turns "the agent has a browser" into "we share a browser". It also makes the phone and e-ink useful for browser tasks, and it is the piece Lilly needs ("go do that in the browser, and I see it and can take over", 01a0b9ab #420).

**Not an iframe.** An iframe would break sites (X-Frame-Options, third-party cookies, logins) and would not be the agent's tab. The pane must paint frames of the agent's real tab and push input back. Verified primitive: `Page.startScreencast` + `Input.dispatch*` (01a0a532 #39).

**What exists.**
- Controller + Pi extension: `~/Projects/os/desktop/agent-browser/` (README there), `~/.pi/agent/extensions/agent-browser`. Enabled on XPSwhite and lambda (`machines.sharedBrowser`). Plan and permission rules: `~/Projects/os/AGENT-BROWSER-PLAN.md`.
- The `browser` mode (`~/.pi/agent/modes/browser.json`) is the only mode that lists the browser tools; keep it opt-in (README "Delegated conversations").
- `agent-browser screenshot … --host xps` already drives the laptop from lambda (see the screenshot in this task).
- Nothing in Chattering streams a browser yet; no `/api/browser/*`, no pane in `app.html`.

**Design already worked out** (01a0a532, 2026-09-15, "Remote AIC"; confirmed still unbuilt in 01a0b9ab 2026-09-19 #457):
1. Controller: add a streaming subscription per tab (today `events` is a polled 300-entry buffer that truncates >12 KB; frames need per-frame acks).
2. Server: `/api/browser/…` relay (tab list, bind, pause/resume) + a WebSocket forwarding frames down and input up, behind the same Bearer/cookie auth as everything else.
3. Client: canvas pane beside the transcript, mouse/touch/keyboard capture with CSS-pixel scaling, thin tab/URL strip from `Target` events, pause/resume.
4. Human and agent input go through the **same per-tab queue** in the controller so "don't type while the agent acts" becomes enforced instead of advice.
5. Only the foreground tab of a window emits frames (tested): **each streamed tab gets its own Chromium window** — this is exactly what "many tabs on the right that are real windows" means.
6. Snapshots first (lower quality while moving, sharp at rest, send only changed rects, at the pane's size); GPU video + sound only if a week of use shows friction. Estimates then: 1–2 sessions for snapshots + resize, 2–3 for video.

**Decisions taken.** Use the person's real profile with saved logins, no artificial separation (01a0b9ab #458; 01a0a532 "I want everyone on my browser"). Lilly's case: controller on Windows driving her real Chrome, reached from WSL through the same SSH-tunnel mechanism the laptop uses (01a0b9ab #463).

**Open.** Pane beside or below the conversation (phone stacks either way); hide lambda's windows on a separate workspace or not; last-touch-wins when laptop and phone view the same tab. Limits to state in the UI: page only, not Chromium's own popups (password-save bubbles, permission prompts); no audio in snapshot mode.

---

## 2. Safe for strangers: installable on Mac / Windows / any Linux, nothing tied to this machine

Revised 2026-09-23 (conversation 01a0cb65) after checking the plan against the project intent: the goal is not a stripped-down "safe mode" but the same product, set up by its person instead of inherited from Maxime's machine. Five rules, each from the recorded intent:

1. **Ask first, then show, never silently off.** Automatic memory is a core promise ("automatically fresh memory removes chores"), so it is not disabled. Nothing reaches a model until the person makes an informed first-run choice; after that, background AI work runs visibly with a stop, a per-kind switch and an estimated cost (item 3). Existing installs keep their choices.
2. **Set up in the app, not hidden forever.** Intent: "configure optional services in the application rather than inheriting personal-machine assumptions." Each optional service has a Settings row with status, a test button, and a plain reason when unavailable. No control fails silently.
3. **Move personal defaults, do not delete them.** Maxime's and Lilly's URLs, voice choices and model move into their own `settings.json` by a one-time migration; new installs start blank. Durable human investment survives updates.
4. **Simple links, real walls.** Keep one-link invites and device pairing. Guest code execution exists only where real confinement exists (today: refused without bubblewrap, `guestSandboxFor`); the words must match that enforcement. Household walls stay honestly described as polite.
5. **Done means a stranger succeeded.** A security review is necessary, not sufficient. "Delivery means successful real workflows, not passing focused tests."

- [ ] **First-run consent.** Before the first automatic model call, one screen: what runs (titles, memory, notes, answer simplification), which model, estimated cost, what content leaves the machine; choose all / some / none. Changeable later in Settings. *Built 2026-09-23, not yet tried by a stranger:* `backgroundAi` in settings (kinds `names`, `memory`), asked once by a first-run dialog, changed in Settings → model; every automatic entry point checks it and `runPi` refuses as a last line. Not built: a cost estimate (the dialog points to the usage dashboard instead).
- [ ] **Capabilities.** One `capabilities` block in `GET /api/settings` (enabled / configured / reason) and one `feat()` gate in the frontend (`design/32` §2). A control whose backend is not configured shows how to set it up, not a dead button. *Started 2026-09-23:* `capabilities` covers the voice services (speech, read-aloud, spoken-digest model) and the effective sound mode; mic and read-aloud buttons hide without them. Terminal, code cells, ink and semantic search still to do.
- [ ] **Optional features pane.** Speech, read-aloud, semantic search, terminal, code cells, ink: switch, URL/path, status, test button, per row.
- [ ] **Blank defaults + migration.** Every machine-specific default moves to `settings.json`, empty for new installs, env as override; a one-time migration writes the current values into existing installs (this machine, XPSwhite, Lilly's PC) so nothing changes for them. New-install `doneSound`: `chime`. *Built 2026-09-23* (`migrateSettings`, `settingsVersion: 2`): semantic, speech, read-aloud and spoken-digest addresses and the memory model are settings now, empty or Pi's default for new installs; a machine that ran before gets its old values written down once. Still personal: the Android APK's default server address (needs an APK rebuild).
- [ ] **Host probe.** Linux / WSL / macOS / Windows detected at runtime, replacing hardcoded paths (native Windows detail: `design/62`).
- [ ] **Walls say the truth.** `people.js` invite warning and the `/guests` page (`server.js` `guestRulesPage`) still describe guests running *unwalled* when bubblewrap is missing, while the server refuses to run anything for them. Align the text with the enforcement; state why and what to install.
- [ ] **Sign-in and access review.** Local-request trust, token strength and storage, cookie and origin checks, the doors (`design/56`), and the public beta blockers listed in b4e35c6f (2026-09-06; re-verify, the code has moved). Outside review before any public link. *Done 2026-09-26 (`design/69`):* every route and live event closed by default (`policy.js`, one gate, a test that fails on an unclassified route); closed two guest-to-owner escalations (install token in settings, machine registration) and the guest leaks through raw transcripts, records and the event stream. Still to do: bring back guest features one by one with project checks (notebooks, reviews, file history, records for guest agents); decide which member routes are the owner's; project memory built from hidden conversations.
- [ ] **Extensions per mode.** A web session loads the extensions its mode needs, not all of `~/.pi/agent/extensions` (PR #8). Pi's extensibility stays; the cost of loading everything goes.
- [ ] **Updates keep work.** Update never restarts under an active run; drafts, conversations, notes and vouches survive update, crash and cache deletion; rollback path exists.
- [x] **Connect an AI from the page, and a first reply.** Plans (Claude, ChatGPT, Copilot), API keys for Pi's 40 providers, model servers (Ollama, LM Studio found by themselves), the model's first words, a three-step welcome; the background question waits for an AI. Every stranger test (archive, .dmg, Setup, the page on three systems) now ends on a saved reply. *Done 2026-09-27, design/73.*
- [x] **Installers a person double-clicks.** Mac disk image, per-person Windows Setup (no console window, uninstall keeps conversations), each with its own stranger test in CI. Not signed yet: the first open asks once (design/73, trade-offs). *Done 2026-09-27.*
- [ ] **Signing.** An Apple Developer ID (notarized app, no first-open question) and a Windows code-signing certificate (no SmartScreen warning). Needs Rockfrog's accounts.
- [ ] **Stranger test (the tick for this item).** A person with no agent helping installs on a fresh macOS, native Windows and one non-NixOS Linux, opens it, chooses consent, signs into a provider, sends a message and sees the reply; then updates without losing anything. Offline: browsing and word search still work.
- [ ] Remove or move to `contrib/` what is personal (tray, snap paths, semantic unit).

**Inventory of what is tied to this machine** (line numbers checked 2026-09-23, before the changes above; the first two lines are now settings):
- `settings.js:34` `semanticUrl: 'http://100.86.49.54:8090'`; `settings.js:50` `doneSound: 'voice'`; `settings.js:27-29` default provider/model.
- `server.js:12618-12622` `KOKORO_URL`, `SPEECH_URL`, `KOKORO_VOICE`, `REWRITE_URL`, `REWRITE_MODEL` — env-only, defaulting to lambda's Tailscale IP. The mic button shows whenever `navigator.mediaDevices` exists → silent failure on a stranger's machine.
- `android/…/MainActivity.kt:156` default server `100.86.49.54:7433`.
- `server.js:7152` `piBin()` probes `~/.nvm/versions/node/v22.23.1/bin/pi`; `agentpath.js` bakes in NixOS paths, `/snap/bin`, the same nvm path, and `:` as PATH separator.
- `server.js:8211` spawns `/run/current-system/sw/bin/du` (NixOS only → false size elsewhere).
- `server.js:7101` `alacrittyBin()`; terminal launch, Claude continuation and `chattering-bridge.py` assume Alacritty + X11 + a Unix pty.
- `sandbox.js` (bubblewrap), `process-supervision.js` (`systemd-run --user --scope`), guest cgroup limits (`design/55`) — Linux-only; must degrade with a stated reason.
- `setup.sh`, `update.sh`, `open.sh`, `tray.sh` (needs `yad`), `windows/launch.ps1`: Linux/WSL only; no macOS launch agent, no native Windows install (`design/62`).
- `semantic/chattering-semantic.service` carries GPU host paths.
- Extensions: every web session loads all of `~/.pi/agent/extensions` (PR #8).

**Why.** The first outside installer (tryingET, 10 PRs + 2 issues, read in 01a0c545 on 2026-09-21): memory limits tuned for a 62 GB box (#5), `TMPDIR` assumptions broken on macOS (#11), 52 extensions loaded into every web session (#8), and "naming is the only thing Chattering sends to a model without being asked, and there's no way to stop it" (#31). The 2026-09-06 distribution audit: the obstacle is the runtime, setup and lifecycle, not the UI (35e4e841 #84; also a04cfad9, 9e90d78f, b4e35c6f, 01a0771a).

**Already designed, not built:** `design/32-ship-readiness-and-feature-flags.md` §2 (capabilities, `feat()`, fresh-install defaults, migration). `design/20-settings.md` for the pane vocabulary. `design/62-native-windows-distribution.md` for native Windows. Host probe idea: 01a04db1 #467-470 ("detect the host at run time; do not ask the user").

**Trade-offs to state.** A first-run question adds one step before the app feels alive; the alternative (silently sending history to a model) contradicts the intent. Per-mode extension loading means an extension a mode does not list is absent from that mode's web sessions. Defaults change only for new installs.

**Same root, do together.** "When I click something it should work or tell me why" (tryingET: dead reader buttons #4, dead file links #6, doc links #9, lost line on reload #10, thinking overflow #3): failed navigation and clicks always surface a message, plus a sweep of file-link paths on a fresh install.

---

## 3. A global view of every AI command, always, and a way to start more

- [ ] A named, typed registry of every one-shot model call (title, retitle, timeline title, distill, epic, memory leaf/pyramid, doc commit title, review repair, simplify pass, speech rewrite) with start time, model, purpose, input size, status, cost
- [ ] One always-available view of these (not only when the panel is open): running, queued, done, failed, with stop
- [ ] Per-command on/off switch in Settings, and a "what was sent, when" log
- [ ] Start a new one-shot command from the app, managed by the Chattering service (survives the tab closing; runs even if no conversation is open)
- [ ] Scheduled/recurring one-shots (the Claude routines idea, `design/57`) as the same kind of object

**Job to be done.** Never be blind. At any moment the person can see every AI program Chattering is running on their behalf — not the multi-turn conversations (the Agents view has those) but the *one user message → one assistant message* jobs the service fires on its own: naming a conversation, building memory, distilling a note, rewriting for speech, simplifying an answer. And they can launch more of these deliberately, from anywhere in the app, without opening a conversation.

**Why.** These calls spend money and send content out, and today they are invisible except as anonymous `pi` processes under **Idle and other processes** (`app.html:3950-3971`, `/api/agents/active` at `server.js:14782`, which lists every pi/claude pid but cannot say *what* a pid is doing). The outside contributor's strongest complaint (01a0c545 #31, need 2): "naming is the only thing Chattering sends to a model without being asked, and there's no way to stop it" — they are on a metered/local provider and wrote a 3,200-line PR (#1) plus #2 and #8 to get control. The durable constraints in project memory say "expose running processes and explicit termination controls" and "make execution, context, costs, ownership, and failure state truthful and inspectable." The Gantt already does this for conversations; this is the same idea for the one-shot world, and it will look different (a list/timeline of short jobs, not a tree).

**What exists.**
- The single primitive: `runPi(fileContent, prompt, onChunk, options)` at `server.js:4785` — spawns `pi --mode json @tmp prompt`, records usage as `chatteringCategory: 'internal'` so the cost dashboard sees it, and goes through `modelhealth.js` (backoff/pause when the memory model fails; `automatic` flag). `runPiJson` at 5371 wraps it.
- Callers (the inventory to name): project retitle 3797/3823, timeline titles 4892, conversation retitle 5008, distill 5092–5149, epic 5231–5273 and 6221–6237, memory leaves/pyramid 5589–5854, note title 6499, doc commit title 10435, review repair 13670. Outside `runPi`: `rewriteForSpeech` 12428 (REWRITE_URL), the simplify pass (`pisdk-rewrite.js`, `settings.simplifyAnswers`), `piHeadlessRun` for web sends (`pisdk-runtime.js:481`).
- Durable supervision for delegated work: `process-supervision.js` (systemd user scope so a job survives a service restart). Reuse for one-shots started from the app.
- Claude routines experiment (`design/57-claude-routines-portability.md`, 01a0c53e, 6b5d50aa): a scheduled one-shot that runs in Anthropic's cloud; three identities (routine, cloud execution, inner session). Relevant as "the same object, hosted elsewhere" — do not merge identities.
- Settings pane vocabulary: `design/20-settings.md`. Agents popover semantics: `design/10-activity-and-agents.md`, `design/50-workspace-scope-and-inbox.md`.

**Shape to aim for.** A `commands` registry on the server (id, kind, purpose, model, started, ended, status, usage, source conversation/project, `automatic` or `requested`), a `/api/commands` stream, and one surface that is reachable from the header on every page and on the phone. Starting one = pick a kind (or free prompt + attached context), pick a model, go; the result is a record you can open, like a one-message conversation. The switches in Settings are per kind; `automatic` calls respect them, requested ones do not.

**Constraint.** Never multi-turn. If a one-shot needs follow-up, it becomes a conversation (fork), not a second turn on the command.

---

## 4. Connectors and MCP: any agent can connect to any MCP server or connector easily

- [ ] Settings → connectors: add an MCP server (stdio or HTTP/SSE), see its tools, enable per mode
- [ ] The agent gets those tools in web sessions, delegated workers, and sandboxed guest sessions (through the key proxy, never a raw credential in the sandbox)
- [ ] Discoverable from the conversation: "which tools do I have here, from where"
- [ ] Same for hosted "connectors" (the Claude/OpenAI connector catalogs) where an API exists

**Job to be done.** A person (or their agent) can point Chattering at any MCP server or connector and use it from a conversation without editing extension code or Pi config by hand. Guests and delegated workers get the same, within their walls.

**Why.** MCP is now how most tools ship. Pi deliberately has **no built-in MCP** (`pi-coding-agent/README.md:499`, "build an extension that adds MCP support"; `docs/usage.md:309`), so today the answer is "write a Pi extension per server", which is not something a family member or a guest will do. The 2026-09-07 records tool design chose to skip MCP because Pi has its own extension system (01a07b9d #18-19); that was right for Chattering's own tools, but it leaves every *outside* tool unreachable. The outside contributor's ecosystem (01a0c545 #59: 34 Pi extension packages, `pi-toolbox-discovery` to keep heavy tools off until needed) shows the demand and the shape: tools must be discoverable and opt-in per mode, not loaded into every session (their PR #8 is about exactly that cost).

**What exists.**
- Chattering's own agent tools are Pi extensions: `extensions/records.ts` (search/show/memory), `extensions/delegation.ts`, `agent-browser` — each gated by a mode's `tools` list (README "Delegated conversations"). This gating is the model to reuse for MCP tools.
- `keyproxy.js` / `keyproxy-worker.js`: guests use the owner's model subscriptions without a key entering the sandbox. MCP servers that need credentials must go through the same idea.
- `sandbox.js`: bubblewrap with DNS and node prefix bound; an MCP stdio server started inside the sandbox sees only the project folder.
- Claude routines attach two MCP connectors by default and can be cleared (`clear_mcp_connections`, 6b5d50aa #7-13): a data point on how hosted connectors are modelled.

**Approach.** One generic Pi extension shipped by Chattering (`extensions/mcp.ts`) that reads a per-install (and per-project) connector list, speaks MCP (stdio + streamable HTTP), and registers each server's tools under a namespace; the mode's `tools` list decides which namespaces a session gets. Settings edits the list and shows "connected / N tools / last error" per server. Trade-off to state: one more process per stdio server per session; lazy-start them on first use.

---

## 5. Sign in with any provider from the model picker

- [ ] Every provider Pi supports (OpenAI Codex, Claude Pro/Max, GitHub Copilot, xAI, OpenRouter, Radius, Gemini CLI, Antigravity, Kimi; API keys; llama.cpp/local; Azure/Bedrock/Vertex/Cloudflare) has a **sign in** action in Chattering's model picker, not only in Pi's terminal `/login`
- [ ] OAuth flows complete in the browser (phone included) and write the same `~/.pi/agent/auth.json` Pi reads
- [ ] "Not signed in" providers show why and how; the picker's `all` button becomes the entry to sign in, not a dead list
- [ ] Claude Code login import works from the web (today it is the `claude-code-fable-5` extension + `claude /login` in a terminal)
- [ ] Guests: sign in with *their own* provider if they have one, else the owner's through the key proxy — chosen per person, visible in the picker

**Job to be done.** A person opens the model picker, sees a model they want, clicks it, signs in with that provider right there, and it works — on any device, without a terminal, without having set it up in Pi first.

**Why.** Today the picker shows signed-in providers first and hides the rest behind `all` (`app.html:9175-9312`, `readyProviders`); the only way to become "ready" is Pi's TUI `/login` or hand-editing `auth.json`. That is fine for Maxime and a wall for Lilly, guests, and anyone installing elsewhere (item 2). Provider integration is a durable constraint in project memory: "Pi compatibility includes extensions and special providers; changing models is not an acceptable workaround." Subscription vs API billing also feeds the usage dashboard (`usageanalytics.js`), so the login path must record which route a model uses.

**What exists.**
- Pi's provider docs: `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md` (subscriptions, API keys, key resolution order, custom providers). Pi's `/login` is TUI-only but the OAuth handlers are library code that can be driven from the server.
- `~/.pi/agent/auth.json` currently holds: google-antigravity, google-gemini-cli, openai-codex, anthropic, xai, openrouter, kimi-coding.
- `claude-code` provider: `~/.pi/agent/extensions/claude-code-fable-5` imports the local Claude Code login and refreshes tokens (01a01104 #371-403, 01a061fc #34, 01a0c0b1 #845).
- Model picker ordering rules: README "Models, branches, and headless runs", `MODEL_POWER_TIERS` in `app.html` (commit 0c2c245).
- `keyproxy.js`: how a guest reaches the owner's subscription without the key.
- Settings `usePiDefault`, `provider`, `model` in `settings.js`.

**Watch-outs.** OAuth callbacks on a remote-served Chattering (Tailscale Serve, Funnel, phone) need a loopback or device-code flow, not `localhost:PORT` only. Never write a provider secret into a guest's sandbox or into a mirrored conversation (`design/52` scrubbing).

---

## 6. Polish the phone and the iFlytek e-ink experience

- [ ] A real week of use on the phone and on the iFlytek with a written list of what broke, then fix in order of frequency
- [ ] Browser pane (item 1) on both devices
- [ ] Global AI commands view (item 3) reachable on the phone
- [ ] APK: server address from the first-launch form only, no hardcoded IPs; Tailscale address option
- [ ] Chattering Anywhere (design/85) for real: rent the relay (anywhere/README.md, ~€5/month), point `encrypted-link-to-your-devices.rockfrog.ai` at it, then a week on a real iPhone and Android phone, mobile data included (reconnect after sleep, relayed path, iOS home-screen pairing). Built and tested on one machine only.
- [ ] Anywhere: carry artifact previews (their own origin) through the tunnel; downloads and background notifications in the Android app's encrypted-link mode (both work only in server mode today)
- [ ] Android app: an update check (sideloaded installs get no updates by themselves); Play Store later (a closed test with 12 testers for 14 days first)
- [ ] test/anywhere.test.js failed once (2026-09-30, a busy machine) and passed 17 times after: find the timing it depends on
- [ ] Pen: aligned, responsive, palm-rejecting, coexisting with finger navigation (constraint in project memory)
- [ ] Voice: intentional completion, audible state feedback, no silence-as-submit; works over the tailnet HTTPS address
- [ ] Notifications ladder (`off / chime / title / summary / voice`) tested end-to-end on each device

**Job to be done.** Direct agents, read results, answer, browse, and mark things read from the phone and the e-ink tablet as comfortably as from the laptop — one hand, touch or pen, no hover, no shortcuts required.

**Why.** Phone, tablet and e-ink are first-class in the project's durable constraints ("essential actions cannot depend solely on hover, shortcuts, color, or animation; controls must not consume the reading surface"). The attention loop (unread → inspect → respond) is exactly what people do on a phone, and it is where the experience is least verified: the memory's status names session recovery, dropped WebSockets (commit 173a336), and read-state sync as unresolved.

**What exists.** `design/23-phone-layout.md` (cards, bottom tabs, compose dock, stacked diffs), `design/11-eink-theme.md`, `design/12-grayscale-theme.md`, `design/42-side-panel-and-inbox-controls.md`, `design/51-work-first-navigation.md`; `android/` (WebView app, native mic → Parakeet, `window.ChatteringInk`/`ChatteringSpeech` bridges, iFLYTEK detection); `sw.js` offline shell; Tailscale Serve HTTPS so mic/copy/offline work everywhere (README). Voice constraints: project memory "Voice submission requires intentional completion".

**Method.** Not a redesign. Use it on the real devices, keep a defect list in this file under this heading, and validate each fix on the device (memory principle: "validate real user workflows on real devices").

---

## 7. Multiplayer, deploy, company hub: multi-user admin done properly

**Goal change, 2026-09-23 (Maxime, conversation 01a0cb65):** Chattering is to be deployed on all three desktop systems, on people's own machines, **and** in companies as one hub machine serving every employee. Until now the project memory listed "immediate enterprise administration" and "departmental isolation" as non-goals, and `design/46` said "yes to think, no to build". That is superseded: the company hub is a goal. Item 2 (safe for strangers) comes first either way. What does not change: local-first, no mandatory cloud service, household use stays simple, Nix is never required.

**The architectural decision to make before building the hub** (`design/46` "The one architectural fact"): who a person is (identity) must become separate from what their agent runs as (the execution principal: its OS user, files, keys). Today every agent runs as the service account, which is why walls between household members are polite. The hub needs spawn-as-principal, per-person and per-group file trees, per-person model keys and costs, company sign-in (SSO/OIDC), roles, retention rules, an audit log members cannot rewrite, backups, and load tests. Proposed, not decided: the hub runs on Linux only; employees reach it from any browser or from their own Chattering. Laptop ↔ hub sync follows `design/52`, with company rules on what may leave a laptop.

- [ ] Concurrent editing: overlapping external edits and live typing reconciled without silent loss (today: disk wins)
- [ ] Regression suite clean: delegation, navigation, floating-surface, presence tests, and the aggregate hang around project-sync
- [ ] Guest network restrictions beyond resource caps (LAN services reachable from the sandbox today)
- [ ] Execution user per guest (running as separate OS users), and a supported way to change it
- [ ] Admin view: people, groups, what each may see/act on, doors open, sign-in log, per-guest budgets — one screen, owner only
- [ ] Deploy: one command that brings frontend + backend to a machine together and verifies the running install (Lilly's PC, XPSwhite, lambda); no more "deployment lags committed code"
- [ ] A rehearsed public-demo invitation workflow, written down as a checklist
- [ ] Company hub: separate identity from execution principal (spawn as the person's OS user), SSO/OIDC, roles and groups, per-person keys and costs, protected audit log, retention, backups, load test. Design first (`design/46` "Team scale"), build after item 2

**Job to be done.** Several people — a household now, a small team or a class next, a company hub after that — work in one Chattering with clear identities, attribution, permissions and budgets; an owner can see and administer all of it; a new machine can be brought to the same version reliably.

**Why.** The single-user workflow is proven by daily use; the multi-user layer is where the records say the product is not yet dependable (memory overview: "installations still require hands-on maintenance, deployments frequently lag committed code, and session recovery, concurrent editing, browser tests, and cross-machine consistency retain unresolved problems"). The public-link demo passed one real external test (Funnel opened, then closed; 01a0c0b1); the next step is making it routine.

**What exists.** `design/46-users-and-multiplayer.md` (identity, presence, shared compose and editor), `design/52-project-invites-and-sync.md` (peers, mirrors, scrubbing), `design/53-guest-walls.md` (bubblewrap, key proxy, console token), `design/54-people-panel-and-follow.md`, `design/55-guest-limits-and-what-they-did.md` (cgroup budgets), `design/56-doors-and-the-guard.md` (LAN / tailnet / public door, lockout, sign-in log at `~/.local/share/chattering/sign-ins.jsonl`). Code: `users.js`, `people.js`, `presence.js`, `collab.js`, `sandbox.js`, `keyproxy*.js`, `sync.js`, `frontdoor.js`, `authguard.js`. Deploy history: 01a0b9ab (Lilly's WSL, SSH both ways, Tailscale), XPSwhite GitHub certificate failure → Git bundle workaround (status).

**Open questions carried from the project status.** Guest worker network policy; changing the execution user of a running guest session; reconciling overlapping edits; whether Fermata is the new name.

---

## Cross-cutting rules (apply to every item)

- State every trade-off to the person; never absorb one silently.
- Machine-specific facts belong in the environment document / settings, never in shared memory or in code defaults (`design/52`, memory constraint).
- Opt-in capabilities live in modes (`tools` lists) and settings switches, not in universal prompt additions.
- Frontend and backend change together; restart only when no web run is active; verify the running install, not the commit.
- Keep this file short. When an item ships, replace its section with one line and the date, and move the detail to a `design/` note.
