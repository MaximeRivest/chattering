# Chattering

*by Rockfrog* — <https://rockfrog.ai>

A place to think and to work with AI agents: every conversation with them on record, searchable and distilled into notes, project memory and epics; files, diffs, reviews and delegated work in one workspace; the same on the computer, the phone and the e-ink tablet.

## Download

| Your computer | |
|---|---|
| Mac with Apple silicon (M1 and later) | [Chattering-mac-arm64.dmg](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-mac-arm64.dmg) |
| Mac with an Intel processor | [Chattering-mac-x64.dmg](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-mac-x64.dmg) |
| Windows 10 or 11 | [Chattering-Setup-x64.exe](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-Setup-x64.exe) (ARM: [arm64](https://github.com/MaximeRivest/chattering/releases/latest/download/Chattering-Setup-arm64.exe)) |
| Linux | the one-line install below |

Mac: open the `.dmg` and drag Chattering onto Applications. Windows: run the
Setup. No administrator password, nothing else to install. It opens on a
welcome that connects your AI (a Claude or ChatGPT plan, an API key, or a
model on your own computer) and gets you to a first reply.

These downloads are not yet signed, so the first open asks once. **Mac:**
click Done, then System Settings → Privacy & Security → Open Anyway.
**Windows:** More info → Run anyway. The one-line install below does not ask.

Until 2026-09-22 this project was called *aiconvo*. Records written under that name are still read; on first start the server moves its data folders to the new name (see `legacy-homes.js`).

On this household's Linux machines, it is installed as a system app:

- The server runs as a systemd user service: `systemctl --user status chattering`.
- A tray icon sits in the top-right panel (via `yad`). Left click opens the app in a Chromium app window (no tabs, no URL bar). Right click gives Open / Rescan / Restart / Quit. It autostarts at login (`~/.config/autostart/chattering-tray.desktop`).
- "Chattering" also appears in the app launcher. The launcher uses `open.sh`: it starts the server if needed, focuses an existing window, or opens Chromium `--app`.

Browse, search, and export all Claude Code and pi conversations on this computer.

## Install from the command line (macOS, Linux, Windows)

One download per system, with its own Node and Pi; nothing else to install,
no administrator rights:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.ps1 | iex
```

It starts Chattering and opens it. Afterwards `chattering-app` opens it
again, `chattering-app stop` stops it, `chattering-app update` updates it
(the previous version is kept: `chattering-app rollback`), and
`chattering-app autostart on` starts it with your session. Your
conversations with Claude Code and Pi are found where those tools keep them.
Details: design/71. What works on which system: design/70. For a team or a
company (company sign-in, walls per person, spending limits): settings →
team, design/72. Connecting an AI: settings → AI accounts, design/73.

## Start from a checkout

```bash
npm run runtime   # optional: the pinned Pi, beside the code
node server.js    # or: node launcher.js
```

Then open the address it prints (the install token signs the browser in:
`node launcher.js url`). `npm test` runs the tests.

## Install on a new machine (Ubuntu or Windows + WSL2)

On Windows, do everything below inside WSL2 (Ubuntu). Enable systemd in
WSL first if needed: add `[boot]\nsystemd=true` to `/etc/wsl.conf`, then
run `wsl --shutdown` and start WSL again.

```bash
git clone https://github.com/MaximeRivest/chattering.git
cd chattering
./setup.sh
```

The script checks Node 22+, installs a systemd user service, starts it,
and prints the next steps. There are no npm dependencies.

Then, on Windows, open <http://localhost:7433> in Chrome or Edge (WSL2
forwards localhost) and use the browser menu → **Install chattering**. The
PWA gets its own window, own icon, and a Start-menu entry — the same
app-like feel as the Chromium `--app` window on Ubuntu.

**First start.** A new install starts neutral: no server addresses, the model Pi uses by default, and the chime as the only sound. Before Chattering calls a model on its own, it asks the owner once: **short names** (titles for conversations, projects and saved documents) and **project memory** (re-reading a conversation after it changes). Each can be on or off; nothing runs until the question is answered, and Settings → model → background work changes the answer later. Buttons a person presses (build memory, update notes, a new title) always work. An install that ran before this question existed keeps what it had: the values it was using are written into its `settings.json` once (`settingsVersion: 2`), and its background work stays on. Details: `settings.js` (`migrateSettings`) and TODO item 2.

Shared GPU services (optional). Semantic search: settings → search, enable the stage and enter the server address. Keep the **namespace** unique per user — it defaults to your username. Voice: settings → sound → voice services takes a speech-to-text server (dictation, spoken replies), a read-aloud server and voice, and an OpenAI-compatible endpoint and model for spoken digests. Empty means not set up: the microphone and read-aloud buttons stay hidden, and speech sound modes play the chime. The environment variables `SPEECH_URL`, `KOKORO_URL`, `KOKORO_VOICE`, `REWRITE_URL` and `REWRITE_MODEL` still win over those fields, and the page says when one does. In this household the servers are on the family GPU server (`100.86.49.54` over Tailscale).

To use it from a phone or tablet on the same local network, open settings → machines and turn on **reach this machine from other devices**. It takes effect at once (no restart) and shows the links to open on the other device; the choice is saved in settings. `CHATTERING_LAN=1` in the service unit only sets the starting position until someone uses the switch; `CHATTERING_HOST` pins the address and disables the switch. The laptop still opens terminals and agent windows. The tablet only needs the link with `?token=…`. The token is stored in `~/.cache/chattering/lan-token`. After the first open, a cookie keeps the tablet signed in. On the e-paper tablet, pick the **e-ink** theme.

Over the tailnet, lambda is served at `https://lambda.tail69222b.ts.net` by Tailscale Serve (a real certificate, so copy, microphone and offline mode work on every device). Tailscale forwards to the local HTTP port and marks each request with `X-Forwarded-For`; the server treats such requests as remote, so the token still applies. `CHATTERING_PUBLIC_URL` names that address so connect links and machine registration hand it out first.

Install the Android APK from `android/app/build/outputs/apk/debug/app-debug.apk`. It detects iFLYTEK hardware and keeps the wide binary e-ink UI. Phones use a separate touch layout: project cards and recent work replace the home Gantt, tabs move to the bottom, conversations use a fixed compose dock, and file diffs switch between full-screen file tree and stacked comparison. The native microphone writes live and final Parakeet transcripts directly into the compose box without opening the keyboard. On first launch, enter the laptop address and token `4148`. Terminals still start on the laptop. Rebuild with `cd android && ./gradlew assembleDebug`. See `design/23-phone-layout.md`.

## People: who is typing, who can see what

Every install keeps a roster of the people admitted on it (settings → people). The owner is the person whose account the machine is; they sign in with the install token, so existing devices keep working. Other people get an invite link, shown once. Your initials or picture open Settings → your profile, where you can set your name, initials and picture. Photos are cropped to a 128px square and saved with your existing user on this machine; People still manages additional users and device links. The profile button identifies you, and its tooltip lists who else is on this machine; a conversation says who is typing in it, and every message, file save and vouch is recorded by name (the home filter has a "mine" choice). When you switch machines from the header, you arrive there as yourself: paired installs exchange a signing key and hand you over with a short signed note, no paste.

Sharing: everything on a machine is visible to everyone admitted, unless its owner hides a project or a conversation (the ⊘ button): "only me", or a list of people and groups with read or read-and-act rights. Hidden things leave the lists, search and pages of the people they are hidden from. These are polite walls between people who share a computer, not vaults: the machine's owner (the account the agents run as) always sees everything on it, and anyone admitted can still ask an agent to read a file. The `chattering` command and the Pi record tools run as the account and are not filtered.

Participation badges, live presence and shared-editor cursors show **other people only**—not you, including your other devices. Your profile/settings button remains visible, and authorship records are kept unchanged. The people button in the header (it appears when someone else is here) opens the people panel: who is here, what they are doing and where — reading a conversation at a message, editing a file at a line — with **go** (take me there) and **follow** (go where they go until you navigate yourself). File rows, the file editor header and the project page show who is there right now. Under that, the project page keeps a per-person account of what others did here in the last two weeks — the conversations they wrote into (opening at their last message), the files they saved or their agents changed, the commits they made — hidden when there is nothing to tell. Details: [design/54-people-panel-and-follow.md](design/54-people-panel-and-follow.md), [design/55-guest-limits-and-what-they-did.md](design/55-guest-limits-and-what-they-did.md).

Inviting someone from outside the household to one project: open the project, press ◎ → "Invite someone", choose read or read-and-act, and send the link. They become a **guest** — they see that project and nothing else on this machine — and can work in the browser right away. If they want the project on their own computer as well, they install Chattering there and run `chattering join <link> --folder <their checkout>`: the two installs become peers, and the project's conversations, notes and memory leaves copy both ways every minute (each side only ever writes its own; what arrives is mirrored read-only under the project, forkable into a local conversation). On this machine, everything a guest runs (agents, run-bash blocks, notebook cells) starts inside a bubblewrap sandbox holding only that project's folder — no `~/.ssh`, no other projects, no keys; their agents use your model subscriptions through a key proxy that never lets a key into the sandbox, and being on this machine is no longer a credential (the local browser and the `chattering` CLI use the install token). Everything one guest runs also shares one kernel-enforced budget — by default a quarter of the memory, half the cores and 512 processes, adjustable in settings → people — so a runaway agent cannot take the machine down. Details: [design/53-guest-walls.md](design/53-guest-walls.md), [design/55-guest-limits-and-what-they-did.md](design/55-guest-limits-and-what-they-did.md). How the link reaches them: the invite dialog offers the doors that are open — your network, the tailnet door (they install Tailscale and accept a share of this one machine; nothing of yours on the internet), or the public door (a switch on settings → machines, owner only: the sign-in page reachable from anywhere, nothing to install on their side). Behind any door, ten wrong sign-ins lock an address out for fifteen minutes and every sign-in is logged. Details: [design/56-doors-and-the-guard.md](design/56-doors-and-the-guard.md). Tool output that strayed outside the project folder, or that looks like a secret, is blanked before a conversation leaves the machine. The environment document keeps project facts apart from each machine's paths and addresses, so an agent on one person's laptop does not run another person's IPs. `chattering peers`, `chattering sync`, `chattering project-id`. Details and trade-offs: [design/52-project-invites-and-sync.md](design/52-project-invites-and-sync.md).

Writing together: the compose box of a conversation is one shared text — two people can type into the same prompt and see each other's carets; the send names both. A file open in the live editor is shared the same way: everyone who opens it edits the same text, cursors show, an agent's write merges in, and the disk follows as people type (the Save button goes away). Details, limits and trade-offs: [design/46-users-and-multiplayer.md](design/46-users-and-multiplayer.md).

## Delegated conversations

Select **pi-orchestrator** in the mode picker. The managed `delegate` tool starts a saved child conversation with an exact parent launch point. Children can delegate again. Delegation shows where it happens: each `delegate` call is a one-line card under its step group in the parent transcript (open it for the result, the brief, the records, and cancel); the runner's return is a quiet `↩` bar; a delegated conversation carries one `↰ delegated by` line at its top that leads back to the exact launch line; the tree shows delegated conversations as dashed nodes under the entry that launched them, recursively. Delegation does not change branch or fork rules.

Execution and parent review are separate. A returned result still needs checks. Pause prevents new descendants; cancellation requests stop the subtree without removing saved files. The ordinary response stop button stops only that response.

Records live in `~/.local/share/chattering/delegations`, not the cache. Web SDK sessions run in separate processes. On systemd, delegated supervisors use independent user scopes. Existing unmanaged processes remain untracked; the app does not guess their parents.

The delegation tools and the browser tools (`agent_browser`, `agent_browser_session`) are opt-in. A mode gets them only when its `tools` list names them: `pi-orchestrator` lists the delegation tools, `browser` lists the browser tools. Every other mode runs without them, so their guidance text stays out of its system prompt.

`extensions/prompt-capture.ts` (installed to `~/.pi/agent/extensions` by setup) records the system prompt twice per turn: `pending` as assembled before the turn, and `wire` as found in the real provider payload. `/sysprompt` shows the wire copy, `/sysprompt pending` and `/sysprompt diff` the rest. Copies land in `~/.pi/agent/cache/sysprompt/<session>-{pending,wire}.md`.

Chattering loads `extensions/delegation.ts` automatically. For the Pi terminal, load it explicitly with `pi -e /path/to/chattering/extensions/delegation.ts`. Terminal roots receive next-turn reminders; web roots receive tracked callbacks. Setup and update install the default mode only when missing, preserving personal mode files.

This update requires matching frontend and server code. Restart the server only after active web runs finish, then reload clients. The implementation, limits, and trade-offs are in [design/29-delegation.md](design/29-delegation.md).

## Records for agents: the `chattering` command and the Pi tools

Every conversation, distilled note, project memory document, epic and evidence card is queryable from any folder, by people and by agents:

```
chattering                                  where was I? (last session in this folder)
chattering search "session abort rpc" --since 30d [--project X]
chattering show <id> [--at 214 --context 3]  one conversation: outline, or a slice around a message
chattering conversations | notes | epics | projects [PROJECT]
chattering memory [PROJECT] [overview|intent|environment|status] [--area REL] | --epic ID
chattering note <id|file> · chattering epic <id> · chattering evidence <id> · chattering help
```

Answers are compact plain text made for a context window: short ids, dates, trust labels (`[unverified]` = no person reviewed the note), and the exact follow-up command. Output is capped (`--max`) and paged. `--json` prints the raw record. The same text is served by `GET /api/records/<op>` and by the Pi tools `chattering_search`, `chattering_show`, `chattering_memory`, `chattering_read`, `chattering_list` (`extensions/records.ts`, loaded automatically for web sessions and delegated workers; terminal: `pi -e /path/to/chattering/extensions/records.ts`). The Pi tools drop the running conversation's own hits from search.

Conversations started from a project get a short "Looking things up" section in their injected context that names these commands. Records are AI transcripts and AI-written notes: a map of what was said, not verified truth.

## Custom themes

System sans and the sidebar are the defaults (narrow screens keep the top bar).
Appearance offers instant, per-browser font choices (theme default, sans,
humanist, serif, monospace), and the top bar remains an option. These use installed fonts; code stays monospace.
Shapes are shared across menus, previews, dialogs, cards and controls.
Themes set `--roundness: 0` for square corners or `1` for the default rounding;
individual radii (`--r`, `--r-sm`, `--r-menu`, `--r-dialog`, `--r-composer`,
`--r-pill`) remain overridable. Built-in e-ink uses the square setting. See
[shared surface shapes](design/45-shared-surface-shapes.md) and
[conversation surfaces](design/43-conversation-surfaces.md). The composer keeps
options, microphone, model and send visible; **+** opens the other controls.

User themes live in `~/.config/chattering/themes/<theme-id>.css`. The fastest
path: import your terminal or Hyprland (Omarchy) color scheme directly:

```bash
node themeimport.js          # auto-detects alacritty/kitty/ghostty/foot/pywal
```

Or copy `design/theme-template.css`, rename its selector to match the file
name, and refresh the app. Valid themes appear in the theme selector.

Validate a theme before use:

```bash
node test/theme-check.js ~/.config/chattering/themes/my-theme.css
```

The theme contract, tokens, modes, and metadata are in
`design/25-themes.md`. The importer and a ready-made prompt for coding
agents are in `design/26-theme-import.md`. `design/tokens.css` is the
built-in runtime source.

## What it does

- Scans three sources: `~/.claude/projects`, `~/.pi/agent/sessions`, and `~/.pi/remote/sessions` (subagent transcripts are skipped). Add more folders in the `SOURCES` map in `server.js`.
- Keeps only user and assistant text. Tool calls, tool results, and slash-command noise are removed.
- Watches the folder. New and changed conversations appear automatically (UI refreshes every 30 s).
- Caches the index in `~/.cache/chattering/`. A restart re-indexes only changed files.
- **Usage and cost dashboard.** Open Settings, then **usage and cost dashboard**. It deduplicates copied fork entries and groups input, output, cache, and reasoning usage by day, model, project, and billing type. Pi's stored cost is shown as an API-equivalent estimate, never as invoice data. Provider rules separate API, subscription, free, local, and unknown routes. Optional monthly fees support subscription-value comparisons. Pi pricing is primary; cached LiteLLM and Models.dev metadata provide fallback prices. The derived ledger lives at `~/.cache/chattering/usage.db`.
- **Reply speed.** Newly hosted Pi SDK replies measure visible answer text, never hidden reasoning tokens. Live status shows an approximate token rate; reply actions show the timing; model-picker rows show recent median speed after three measured replies. The usage dashboard gives min/median/max, percentiles, raw characters/second and first-text wait. Token rates always carry `≈`; short or single-chunk replies are not rated. Measurements stay with session metadata and rebuild into the usage ledger. Terminal sessions and older replies cannot supply this timing. See [definitions, coverage and tests](design/60-response-speed.md).
- Distills one conversation into a problem tree and a reusable note.
- Groups selected conversations into an epic with a chronological, cross-session narrative.
- **Trust / vouch.** Most notes, memory documents, and epics are AI-generated, so nothing generated is treated as verified truth. A **vouch** records one human assertion — “I checked this exact content at this time” — in an append-only ledger (`~/notes/chattering/vouches.jsonl`). Vouches are granular (whole file, note section, or selected lines) and anchor to exact line text: a moved line keeps its vouch, a changed line silently loses it, so staleness falls out for free. A **dispute** marks content as wrong. Trust never hides anything; it only labels content everywhere — in file views, note views, project trees, and agent briefings (`[vouched DATE]`, `[partly vouched]`, `changed since review`, `[disputed]`, `[unverified]`). See `design/24-trust-vouch.md`.
- **Editing.** Three levels of direct editing, all saved to the native files:
  - **Whole-file view** — the `edit file` button edits the current on-disk file in place. Saves are atomic and optimistic (a base hash refuses the write when the disk changed after the read). Writes stay inside indexed repositories or indexed conversation directories.
  - **Notes, epics, and project memory** — every markdown view under `~/notes/chattering` has `edit file`, and each selected section has its own `edit` that splices only that heading and body back into the file.
  - **Transcripts** — every message (user text, assistant text, tool input, tool result) has an `edit` button that rewrites the one entry in the native JSONL (`~/.claude/projects`, `~/.pi/agent/sessions`). The server parses the target line, changes only the target field, and re-serializes it, so the format stays valid. Tool inputs must stay valid JSON. If a live agent owns the session, the server stops it, applies the edit, and reopens the terminal so the agent resumes with the edited context. Each edit keeps a backup under `~/.cache/chattering/edits/`.
- **Models, branches, and headless runs (pi).** The blessed fast path next to the sovereign terminal:
  - **One model set per conversation** — the composer shows the models for the next reply. One model makes one run. Two or more models make parallel Pi-native forks. The selected set updates immediately and persists on the server.
  - **Model picker order** — signed-in providers first, then alphabetical provider/family groups, newest numbered generation first within each family, then strongest named tier: Astra → Sol → Terra → Luna; Fable → Opus → Sonnet → Haiku; Ultra → Pro → Flash → Flash Lite. Versions compare numerically (`5.10` before `5.9`); Claude's `5-1` and `5.1` are equivalent. Standard editions precede their dated snapshots and batch/free variants. Unversioned aliases such as `latest` follow numbered releases; unknown tiers follow ranked tiers, and unknown families use natural name order rather than guessed release dates or strength. The central `MODEL_POWER_TIERS` table and family parsing live beside `sortedPickerModels` in `app.html`. This affects Chattering's shared web picker, not Pi's terminal picker.
  - **Project default model** — each project panel has one default. A new conversation inherits it unless its launcher selects another model set. Existing conversations keep their own selections.
  - **Headless send** — the composer's `send` button drives a warm `pi --mode rpc` process on the session file (same extension discovery as the TUI). Follow-ups reuse the process; it exits after 5 idle minutes, or at once if you open a terminal. Progress streams live into a run card; runs are jobs with an abort button. Slash commands and images still use `open & send`.
  - **Send from any node** — in the tree view, `send from here…` continues from any entry. One model = an in-file pi branch (a label anchor, nothing rewritten). Several models = one pi-native fork per model, run in parallel; the family tree shows them as sibling branches.
  - **Parallel runs are web-only** — one terminal runs one model. With two or more model chips set, `ctrl+shift+enter` and terminal sends refuse with a hint. Remove extra chips to use the terminal.
  - **Aggregate** — on a node with two or more answer branches, `aggregate replies…` quotes each branch's answer with its model name and asks one model to synthesize, continuing on the original conversation.
  - **Trace transcript** — the transcript shows the path to your head through the entry tree (see *One head* below). `everything` mode keeps the complete file record.
  - **Ownership rules** — the terminal is sovereign: opening one aborts any headless run on that file. A headless send or model switch refuses while a terminal owns the session, with an explicit force option that stops the terminal first. Every run holds the per-file operation lock. Approval prompts cannot be answered headlessly: the run is marked `needs a terminal`.

## UI

- **Home is the whole-system view.** The timeline toolbar keeps just four project sort buttons and a magnifying-glass project search. The “now” marker sits below the date labels, without overlapping them. Desktop keeps the work-first sidebar, with space around the chart. Every click lowers one level: a project label opens the project, a violin mark opens its conversation, a green square opens its note, a triangle opens its epic, and the `⌂ branch` link on a project row opens its Git history.
- Below home, a **breadcrumb spine** (`❯ home ▸ project ▸ conversation ▸ …`) sits under the top bar. Each segment is a link. Clicking the conversation segment while reading it opens a sibling quick-switch list for the same project. The brand button always goes home; shift-click also clears every filter.
- One router owns navigation. Every view has a hash route, so the browser back button, refresh, and deep links work everywhere. The app never navigates by itself: live updates only patch data, show a toast, or a badge (`design/22-home-and-router.md`).
- The home timeline is a Gantt. Four layouts: horizontal, vertical, full-screen project swimlanes, or hidden. Pick a layout with the timeline icons, or press **g** to cycle. The choice is saved.
- The bottom and full-screen layouts have a row toggle. **rows: project** is the default and groups work by project. **rows: compact** restores the original shared-lane view, while project colors remain. Project groups sort by their most recent message. Overlapping conversations use separate tracks. The chart renders only the visible time window for fast scrolling and zooming.
- Use the project selector in the Gantt toolbar to show one project or repository. This filter also applies to notes through their source conversations.
- Click a project label on the left of the Gantt to open a project overview. It shows memory health, workstreams/epics, recent conversations, and a launcher for a new conversation in that project root. **update all notes** distills every conversation without a note and re-distills every stale note, with two model jobs at a time. **build project memory** classifies every user message for durable intent, keeps the preceding assistant response as context, and writes a high-level overview, deep intent note, safe environment guide, and current todo/focus note. It also proposes project-wide epic candidates for review and one-click building. Secret values never enter the environment document. The launcher remembers the selected agent per project. **start** (pi) creates the session in the app and sends the briefing through warm RPC. **in alacritty** is the desktop TUI escape hatch. Claude still starts in Alacritty only. Its briefing lists project memory first, then chosen epics, fresh note paths, and selected evidence. When **read all current notes** is selected, the kickoff tells the new agent to read every listed note.
- Open **changes** next to a conversation's note / evidence / tree to see what that conversation changed: the files browser in Changes mode, filtered to it.
- The **repos** tab (key **4**) lists local Git repositories and worktrees; a repository opens in its project's files browser.
- A project overview's **files** switch opens the files browser (see *Files*).
- Note views carry the trust controls: **✓ vouch** and **✗ dispute** act on the browser text selection or, with no selection, on the whole note. Notes show their trust state next to the title, and every section has **✓ vouch section**. The project overview has a **trust** section that works as a review queue: disputed and changed-since-review content first. The new-conversation briefing warns the agent that memory may contain disputed content. Code review happens in the change review, not in the editor.
- Continuous zoom with three presets: **hrs**, **days**, **wks**. Zoom with **Ctrl+wheel** (anchored at the pointer), **+** / **-** (anchored at the viewport center), or **0** to reset. Grid ticks follow the zoom: hours, days, or weeks. Mark labels hide at low zoom; hover still shows details.
- Jump with the toolbar buttons or keys: **n** to now, **b** to the oldest session, **t** to a date field. A view pinned at now stays pinned across live updates.
- On the chart the wheel scrolls along the time axis. Shift+wheel scrolls the cross axis.
- The ergonomics are specified in `design/07-gantt-ergonomics.md`.
- Each bar shows session duration; message density sets the violin thickness.
- Mark colors identify projects, not Claude or Pi. The project comes from the working directory.
- The lane layout tries to keep conversations from the same project together.
- Four or more short conversations from one project within 15 minutes collapse into one wider mark.
- Labels use compact titles with at most 10 characters. Hover to see the full title and details.
- Titles come from the first real user request. Memory-briefing bootstrap prompts ("Read …/briefings/….md") are skipped, so injected sessions are named after the actual work.
- Titles are editable. In the conversation header: double-click the title (or click the ✎ pencil) for an inline edit — Enter saves, Escape cancels. The **↻ title** button asks the model for a fresh title and timeline label. Both write a durable override in `~/.cache/chattering/timeline-titles.json`; a manual title survives re-indexing and is never overwritten by the background labeler.
- Snippets are sentences you repeat often. Type `;;` in the composer (the trigger is a setting) and the letters after it filter the list; Enter or Tab replaces the token with the snippet, Esc keeps what you typed. The `;;` button and **alt+;** open the same list detached (phone, e-ink). **alt+shift+;** saves the composer selection (or the whole draft) as a new snippet; user messages have a **snippet** hover action for the same. `$1`, `$2`, `$@` in a snippet become blanks: the first is selected on insert and Tab walks to the next. Files live in pi's prompt folders — `~/.pi/agent/prompts/<name>.md` or `<project>/.pi/prompts/<name>.md` — with `kind: snippet` in the frontmatter, so the pi terminal also sees them as `/name`. Project files need the project trusted in pi before the terminal lists them; Chattering inserts them either way. Use counts live in `~/.cache/chattering/snippet-uses.json`, never in the files. The settings panel lists every snippet and opens its file in the Markdown editor.
- Enable **include tool calls in timeline density** in Filters to include tool calls.
- Click a mark to open it. Shift-click or Ctrl-click marks to select conversations.
- **Drag on the timeline** to select every conversation in the rectangle. Shift-drag adds to the selection.
- The notes tab uses the same timeline: notes are green bars that span their source conversation. Each mark shows a compact title from the note's filename slug (date dropped, at most 10 characters); hover shows the full name.
- **Search (`Ctrl+F` or `/`)** opens a modal that searches everything as you type: conversations (messages, tool calls, results, thinking), distilled notes, epics, and project memory. An SQLite FTS5 index under `~/.cache/chattering/search.db` answers in milliseconds; it is a derived cache and rebuilds on the next boot if deleted.
- Results are ranked passage cards grouped by conversation or document: role, marked snippet, match count, and branch / hidden-record flags. Click a passage (or `↑`/`↓` then `Enter`) to land on that exact message — folded branches open automatically when the match hides there.
- Multi-word queries AND their words; `"quoted phrases"` match exactly; the last word prefix-matches while you type. Operators: `project:chattering`, `role:user`, `source:pi`, `type:note|epic|memory|conversation`, `after:2026-08-01`, `before:…`, `path:server.js`.
- Inside an opened conversation, `n` / `N` walk the highlighted matches of the query that led there, with a `match 3/17` counter; expanding folded content recounts.
- Ranking weights title > note and epic sections > user > assistant > tool text, with small boosts for fresh work and the selected project.
- **Optional semantic stage** (settings → semantic search): a late-interaction ColBERT service on the GPU server (`semantic/`) adds meaning-based matches — it forgives reworded speech-to-text queries. Lexical paints first; `≈ semantic` passages merge in when they arrive. The host pushes changed units through a resumable ledger; a dead server silently means lexical-only.
- **Source dropdown** filters by agent (claude, pi, pi-remote).
- **Directory dropdown** filters by working directory.
- **"Export selected (.md)"** downloads the chosen conversations as one simplified markdown file.
- Every copy and export starts with a provenance block: the session id, the full path of the original transcript, the extracted JSON, the distilled note, the epics it belongs to, and a Chattering link. A receiving agent can follow these paths to learn more.
- **Select conversations + "Build evidence"** prepares and caches evidence without creating an epic.
- Open one conversation and select **evidence** to view existing evidence. It builds once only when none exists.
- Select **rebuild evidence** inside the evidence view to replace it explicitly.
- **Select two or more conversations + "Build epic"** creates a timeline for the larger problem.
- **"Epics"** lists saved timelines. Rebuild an epic to add selected conversations or include new work.
- Focus a conversation to get direct links between its conversation, note, evidence, and related epics.
- The filters popover has a **theme** select: auto, dark, light, grayscale, or e-ink. Grayscale removes hue but keeps grey tones (`design/12-grayscale-theme.md`). The e-ink theme is binary black/white: no greys, no opacity, no animation (`design/11-eink-theme.md`).
- On e-ink, Gantt states are drawn without color: hatched fills for selected marks, a dashed frame for the open conversation, a static dot for live sessions. The transcript is paginated instead of scrolled: **[** / **]** or PageUp / PageDown turn pages, and the last page follows new messages.
- These links appear in the fixed content header. They do not replace or change the Gantt timeline.
- Open an epic and select **evidence** to inspect every note or evidence card used for that build.
- The evidence view marks distilled notes, cached cards, new cards, missing conversations, and possibly outdated notes.
- The **tree** tab in the artifact switcher shows the conversation as a message tree. The root is at the top and time flows down. Each box is one user message or one merged assistant turn, titled by its first sentence. Solid boxes and green edges mark your head's path (what you read and where your next message goes); dashed marks other branches. Clicking a box moves your head there. Branching is a context-engineering strategy, so other paths are first-class history, not failures. The transcript shows one coherent reading path, with labelled alternatives at each divergence; exports still label other-branch records. Both formats store real trees: pi entries have `id`/`parentId`, Claude Code entries have `uuid`/`parentUuid`.
- Select a box to get up to four actions. **read from here** opens the transcript at that message and highlights it. **continue from here** (pi only) puts your head exactly on that message: nothing is written until you send, and then the new message starts a new in-file branch there (one no-op `label` anchor, the same one pi's own branch flow writes, so a terminal resume picks up there too). **edit this message** opens the same branch-preserving editor as the transcript. Saving a Pi question creates another path and generates an answer while keeping the original. **fork (copy)** continues from that message in a NEW session file; the original does not change.
- Pi forks use `SessionManager.createBranchedSession` on a private snapshot of the saved source file. This file-only utility is used for both SDK and RPC agent configurations: it starts no model or agent process, never stops the original runtime, and cannot migrate the original file in place. Pi preserves the selected ancestry, model/mode records, and labels; Chattering restores the original `parentSession` link and atomically publishes the finished file. Claude forks copy the root→node chain with `sessionfork.js`. Snapshot and publication safeguards live in `session-snapshot.js`.
- Branch vs fork: a branch changes the continuation in the same conversation, so it still requires exclusive ownership. A fork copies history through a selected saved entry into an independent conversation and **can run alongside the original** without waiting for its current response. Text still streaming beyond that entry is not included. Active delegated-worker sessions retain their ownership restrictions. Conversations share the project's current files: a fork is not a Git worktree or file rollback. The first Pi fork may take a few seconds to load the public SDK; later forks reuse that import. Copying uses temporary disk space, cleaned up afterward, to protect the original and keep incomplete forks out of the index.
- The tree shows the whole **fork family**, not just one file. Sessions that share their first entry id (all forks copy the root chain) or that point at each other via pi's `parentSession` merge into one tree. Boxes that live in a linked fork are magenta with an **↳ fork** tag; their read and fork actions target that session. This covers forks made in Chattering, forks made in the pi TUI, and Claude fork-session files.
- The list and timeline show **one row per fork family**: the origin's title, the family's whole time span, and a `⤑N` badge. Opening the row lands on the newest branch (or the one already open). A separate conversation has a visible origin link in its transcript. A filters checkbox (`show fork branches as separate rows`) restores one row per file.
- **T** opens the tree with a keyboard cursor: `↑ ↓` walk parent/child along the active path, `← →` walk sibling branches and forks, `enter` opens the action menu, `r / s / b / f / a / e` run read / send / continue / fork / aggregate / edit directly, `T` or `esc` returns to the transcript.
- File controls use one interaction grammar. Click opens the best Chattering view: images preview in a lightbox, file changes open their recorded diff, and plain paths open a current-file preview. Ctrl-click opens the current disk file with its system application. Right-click, or long-press on touch, adds **open in chattering**, **view this change**, **open with system application**, **show in folder**, and **copy full path** when applicable.
- **Simpler answers:** web SDK replies get one automatic editing pass using the same model at its lowest supported reasoning setting. The full explanation is rewritten, not summarized. A fresh visit shows **Simpler version**, with **Original** one click away; an answer already being read stays original until you switch. The automatic request remains hidden in the saved conversation, preserving its context for future turns. System instructions, tool descriptions, and the conversation prefix are reused, although changing reasoning can reduce provider cache reuse. This adds one model call. Turn it off under Settings → model → conversation answers. Terminal/RPC runs, delegated workers, and internal callbacks are unchanged. See [the simpler-answer design](design/39-simpler-answers.md).
- Each transcript message has **copy**, **read**, and **more…** controls. Copy preserves the complete Markdown. The menu includes edit, regenerate, continue here, and fork where supported.
- **Artifacts.** Things an agent makes open beside the conversation. A web page or app, a slide deck, a PDF, a document, a picture: the agent writes real files in the project and calls its `artifact` tool; a card appears in the answer and the **artifact panel** opens on the right (a full-screen sheet on a phone). The panel shows **the version from where you are reading**: move to an earlier answer or another branch and it shows the files as they were there (Chattering keeps a version of the artifact's folder, pictures and fonts included, after every tool call); at the end of the conversation it shows the disk, and says when the disk changed since. **Version n of m**, reload, open in a tab, full screen, and **Ask** (a reference in the message box). Small visuals (a chart, a tiny game) appear right in the answer with the agent's `show` tool, and every `html` or `svg` code block gets **▶ preview**. Everything runs on a separate **preview address** (port 7435 here, `https://<machine>:8443` through Tailscale), never on Chattering's own, and speaks the open **MCP Apps** standard; pages get the current theme as the standard CSS variables, including e-ink. Slides: `deck.json` plus one HTML file per slide, with thumbnails, present mode and print to PDF. **Finding them later:** the right panel's **Artifacts** list (beside Files, with the same All / Project switch, a search and all / files / inline) holds every artifact of every conversation you can see, newest first; opening one goes to the answer that made it and opens it in the panel. The project page lists its newest artifacts, and files that belong to an artifact carry a ◧ in the Files list. The lists come from the conversation index itself, so they update live with no scanning. Pages may load and call anything by default; Settings can limit them to the public library sites. See [artifacts](design/67-artifacts.md).
- **One head: what you read is what continues.** The transcript is the path to your head; your next message continues from it. Several answers to one question sit side by side at that point, as cards, streaming while they are written: click a card (or swipe on a phone) to choose it, and the rest of the conversation below follows it at once, without a reload. **‹ 2/3 ›** arrows step through versions of an answer (regenerations), wordings of a question (edits) and any other place the conversation divides; the path you last read below each point comes back. The cards take the whole width (**all**), **two** at a time, or **one** at reading width with its neighbours peeking — a per-device choice; phones and e-ink always read one at a time. **↻** on a card asks that model again (the same question from the same point, no invented turn). **Merge…** picks answers, a model and an instruction; the merged reply becomes one more card and the conversation continues from it. **Include all** continues with every answer's text in context. The head is saved per person and shared by that person's screens (laptop, phone, e-ink); other people's reading never moves yours. **Continue from here** in a message's menu makes the next message start a new path at that point; what came after stays saved. Files on disk are not rewound by moving the head. See [one tree, one head](design/66-one-tree-one-head.md) and the [Open WebUI study](design/65-open-webui-study.md) behind it.
- The header ticker shows the latest session update. Click it to open that conversation.
- **"● N"** in the header lists running, writing, and recent agents (key **a**), each with its working directory. Running means a live `pi` or `claude` process. Writing means the session file changed in the last 5 minutes. Click a row to open the conversation. Each conversation row has a **⋯** menu (or right-click): **pin** it to a section at the top, **mark unread** so it comes back into the inbox, or **remove** it from the inbox until it replies again. With the panel focused: **p**, **u**, **Delete**. These marks are shared by every device, like read receipts.
- **Side panel layout** (settings → appearance → layout, saved per browser): There is no left icon rail. The panel's top row holds the **machine picker**, then **Gantt**, then the project-memory button and its picker. A floating **Files** icon opens the right-hand file panel; **All / Project** switches between global and selected-project file activity. **✕** or Escape closes it, leaving no rail or reserved space. The left panel stays available. On narrower desktops the file panel overlays instead of squeezing the workspace. At the top of the panel, the project button opens its memory page; the small adjacent arrow switches projects. Back/Forward and **+ new here** share the next row. Your initials or picture are the first bottom-left button and open Settings; there is no separate gear or Agents button. The left panel always shows Unread, Read and Working; older saved project-list selections are migrated automatically. The project picker offers search without replacing the sidebar. Gantt opens the conversation timeline. Expanded Gantt charts stay beside—not beneath—the sidebar.
- **Long sidebar lists** load more as you scroll, with a Show more fallback. The project picker chooses the project used by **Read → Project** and **Files → Project**. Each panel has its own **All / Project** choice; Unread and Working always stay global. Files also offers **human | agents | both**; existing retention bounds still apply. See [recent file activity](design/47-recent-file-activity.md).
- **The side list** (`a`) holds the conversations you opened, newest conversation on top, the way a messaging app lists chats. It starts empty. Each row shows the last thing said (or what the assistant is doing, and for how long); three pulsing dots mean it is working; a bold title with a green dot means it replied and you have not read it; an amber `?` means it asked you something; a red `!` with a Resume button means the run stopped. ✕ closes a row (Undo in the toast; it also comes back if the assistant replies again). Processes with no row of their own fold under **Other processes** at the bottom. See [the side list](design/59-open-list.md).
- **Agent counts** are off by default: when the panel is hidden, its floating reopen button shows a quiet dot for unread replies or interruptions, and changes its symbol while work runs. Enable unread counts in Appearance → **Show unread counts when the side panel is hidden**. These are machine-wide; routine background jobs never raise the badge. `` ` `` hides the whole panel; a floating reopen button keeps the attention badge visible. Phones keep the top bar. Themes shape the panel with `--panel-bg`, `--panel-r`, `--panel-row-r`, `--panel-border`. The conversation title stays quiet and the composer stays pinned.
- Ordinary conversation switches land at the bottom, at the newest messages. Browser Back and returning from a file restore the reading position; explicit message links retain their target. Late-loading images and layout changes keep that landing stable until you scroll or interact with the page.
- **Back and forward** (`‹ ›` next to ⌂ in the bar or the column, `alt+←` / `alt+→`, the browser's own buttons, Android's key): the app keeps its own history of screens, so both directions work in the standalone PWA and the Android app too. Hover names the screen behind; hold or right-click an arrow for the list. Every screen comes back at the scroll it was left at; a reload keeps the whole history of the tab. See [design/44](design/44-back-and-forward.md).
- **Settings → background jobs** (`j`) shows running and recent background tasks. Their routine completion/failure events stay here rather than raising a toast; agent replies and failures still alert, with a click through to the conversation.
- **"settings"** opens the memory-model panel. Pick any model from your Pi catalog. Signed-in providers are listed first. **use pi default** follows `~/.pi/agent/settings.json`.
- Background jobs continue when you open another conversation. You can start multiple jobs in parallel.
- Every Pi or Claude conversation has **continue in alacritty** and an **open & send** box. chattering starts the native CLI in Alacritty through a thin PTY bridge. The window still looks like a normal Alacritty session. The web UI can read the screen and send keys. If Claude asks “resume from summary?”, the box shows that choice. Send pastes images (Ctrl+V) and text (bracketed paste), then Enter.
- **start conversation** on a project overview does the same for a new session: it writes the briefing, then opens Alacritty with the kickoff as the first prompt.

## Files

**Conversation / Files** in the conversation bar (or **F** while reading a conversation) opens the project's files without changing the home view. The project summary's **files** tab opens the same browser. The former global lens switch is removed.

- **Browse:** folder listings, breadcrumbs, repository selection, filename/content search, and a rendered README underneath. **Edit & run** opens that README in MRMD. Search is literal and case-insensitive; it skips dependency folders and binary contents, and reports when its result/time/size budget is reached. Symbolic links are displayed but not opened by the browser.
- **Highlight:** this conversation, since your previous Files visit in this browser, last X recorded changes, last hour, last 24 hours, or a custom time range. Folders aggregate descendant activity. **Changed only** hides unaffected entries; otherwise the whole directory stays visible.
- **Changes:** expandable combined comparisons, side-by-side or unified, plus individual activity records with conversation links. Filter by agent, editor save, external/unknown, or Git. Filters select files and activity, not individual authors' lines within a combined diff. **Reviewed** is explicit; simply opening a diff only marks it seen. **Flag for follow-up** is independent. Review/flag state is local to this browser, and a changed selection requires review again.
- **The file:** one screen, one header row. Markdown edits in MRMD (autosaves, runnable cells); code in CodeMirror (explicit Ctrl+S). A file the project cannot edit (a log in `/tmp`, a file under home) opens read-only in the same screen. **History** swaps the editor for a read-only list of recorded versions: read one, step older/newer, or compare two — drawn with the change review's diff component; the route names the versions, so a link or refresh lands on the same view. **Return to Live** remounts the editor. **Back** returns to where the file was opened from: the conversation (at the link that opened it), the review, or the browser. On a phone History and Ask sit under ⋯. Conversation drafts and reading positions are retained; the open file is remembered for the conversation during this page session.
- **Images, video and PDFs:** images have Fit / Actual size; videos use native playback and seeking; PDFs use a bundled reader with search, page navigation, text selection, zoom and password prompts. All are read-only, with Reload and Download. Phone/tablet controls are touch-sized. Video playback depends on the device's codecs; no conversion service runs.
- **HTML Source / Preview:** preview your current editor contents without changing its saving policy: shared editing still autosaves; explicit-save editing keeps unsaved drafts. The preview itself never writes the file. Local CSS and images work within the file's folder. Scripts, forms, external resources and navigation are blocked. This is an isolated visual preview, not a running web app. See [viewer architecture, limits and testing](design/48-image-file-viewer.md). The Android APK adds fullscreen video and authenticated downloads; existing installs need the updated APK for those native features.
- **Live and safe:** incoming file activity shows a refresh/reload notice rather than replacing a review or moving your cursor. A stale save is refused. Unsaved code drafts survive navigation in sessionStorage.
- **✎ ask for a change** (Ctrl+K) docks a composer under the file. Your prompt goes, with the file (line-numbered; a ±200-line window for big files), your selection or cursor line, the file's recent edit sessions, the other files those sessions touched, and — for a new conversation — the project map, to the newest free conversation of the project that touched this file in the last six hours, or to a new conversation rooted at the project (or its declared area). The chip shows the pick; flip it. `what goes along` shows the exact text. While the run is active the editor is read-only (a banner, `stop`, `open the conversation`); when it settles the file reloads and the status says `agent changed +a −b`. The file stays attached to that conversation as an `@file` chip, so later sends from the transcript keep it.

Behind it is the **file edit ledger** (`~/.cache/chattering/files.db`, `fileledger.js`): one row per recorded change, from transcripts as they index, Git when a repository's history moves, the editor's saves and commits, and filesystem watchers on every active project's repositories (started at boot; `CHATTERING_NO_WATCH=1` turns them off). A watcher event within a few seconds of an agent or editor change is the same change seen twice and is dropped; the rest is `external`, never "you". Fork twins (the same tool calls copied into forked session files) collapse into one session. The ledger is a derived cache: delete it and the next boot rebuilds it (a background job in the jobs panel). `GET /api/files/timeline`, `/api/files/touched?path=`, `/api/files/ridge?name=`, `/api/files/project?name=`, `POST /api/files/ask`.

The browser adds `GET /api/files/browse?name=…` and `/api/files/activity?name=…`. Activity queries are project-scoped and capped; browsing verifies repository membership and resolves directory symlinks before checking containment.

**Saved file history:** `file-archive.js` stores editor saves and observed filesystem versions, including deletions and recreation, separately from the activity cache. The private archive is `~/.local/share/chattering/file-history/versions.sqlite`; back up its directory. Editor and watcher events link to exact saved before/after versions where available. Existing Git snapshots and labelled agent reconstructions remain accessible.

**History limits:** filesystem watching is not a continuous recording and may miss rapid intermediate writes. Capture starts at observation, never retroactively. Text files up to 2 MiB are captured; binary/oversized contents are marked unavailable. The default database budget is 512 MiB plus SQLite journal overhead; reaching it stops capture with a warning, not deletion of old history or blocking file edits. Use `CHATTERING_FILE_HISTORY_MB`, `CHATTERING_FILE_HISTORY_DIR`, or `CHATTERING_NO_FILE_HISTORY=1` to configure it. Copies can retain subsequently deleted secrets: permissions are owner-only, but contents are not encrypted. The drawer lists the latest 2000 saved versions; older explicit snapshot links remain valid. Full-project rewind, shared review state, and selected-range inline editor markers remain unfinished. See [the browser design and implementation status](design/35-files-browser.md).

Other deliberate trade-offs: code does not autosave; the editor locks while an agent run is active on the target conversation; the ask composer is its own small box, not the full conversation composer (no snippets, `@` palette, or dictation there yet).

## Focused live editing

**Edit live file** opens a focused editor with a return link, filename and Save—no file tree or history panels. Code uses CodeMirror 6 with native language support, local completion, search and quiet gutter change markers. Hover the gutter for version-checked Git attribution; uncommitted authors stay unknown. Changes are calculated off the main thread and opening does not wait for repository history.

Markdown uses runnable MRMD with Run / Run all and output fences. Cells in Python, R and Julia (and shell) run on rat kernels resolved for the notebook (`rat run --doc`), so the terminal, VS Code and this page reach the same kernel; output streams as it is printed, a cell waiting for input asks here, and Stop interrupts the code without losing variables (code that ignores the interrupt is offered "stop the kernel" after a few seconds). The kernel chip, its menu and the variables drawer follow the language of the cell that ran; completion comes from the live kernel and replaces what the kernel says (`data.frame`, `df$col`). Plots, and interactive displays (plotly, R htmlwidgets, Julia HTML charts) stay in the document where they were printed: images, and pages saved in `_assets/generated/` embedded in a sandboxed frame (served with CSP `sandbox`, so their scripts never reach Chattering). A notebook declares its environment in front matter (`rat.python.dependencies`, `rat.r.dependencies`, `rat.julia.dependencies`, `requires`, an optional `project` pin); the strip under the editor shows rat's verdict and, when something is missing, a **make it run** button (`rat ensure`: environments, missing packages, lock files — `.rat/python.lock`, `.rat/r.lock`, `.rat/julia/Manifest.toml`, committed with the project so the next machine gets the same versions — and a kernel restart only when needed). A failed import (or R's "no package called", Julia's "Package not found") offers to declare the package in the notebook and install it. Nothing installs without a click. The download carries rat (the version `.rat-version` pins; a newer rat on the machine is used instead) but no language: when a notebook needs Python, R or Julia and the computer lacks it, **set up …** shows rat's guide for this system (`rat guide`), to follow or to hand to an agent as it is. A notebook may declare prerequisites (`rat.after`); they run first, once per kernel. The **notebook** action beside copy/read on an assistant answer writes that answer as a self-standing notebook into the project's `documents/notebooks/` (one model call on a private copy of the conversation; nothing runs) and leaves a card under the answer. See [notebooks that just run](design/41-notebooks-that-just-run.md). A notebook you run a cell in joins a **Notebooks** list in the side column, under the conversations: leaving it no longer stops it — the cell (and Run all's queue) goes on, results land in the document and on disk, and the row shows running, waiting for input, or finished unread; coming back shows the same editor. The page writes those results, so closing the window mid-run loses that output (it asks first). See [notebooks that keep running](design/68-open-notebooks.md). In this focused view, Save writes to disk, not a Git commit; Markdown also autosaves. Incoming disk edits do not replace your work, and stale saves are refused. A language-service adapter boundary is available for completion, hover, definitions and diagnostics, but no language servers are installed or started automatically. See [the focused editor design and limits](design/37-focused-live-editor.md).

## Checkpoint reviews

Tool groups in a conversation now offer **Review changes**. This opens a pinned, PR-like comparison of the group: combined changes or individual steps, expandable file diffs, recorded-file reading, live editing, line/file comments, suggested replacements, and explicit review status. Saved comments and review checks are stored on the server; suggestions are not applied automatically.

**Preview review package** collects unresolved comments, their recorded code context, suggested replacements, and bounded live differences. Sending requires confirmation and targets an existing Pi conversation in the project. Review-linked follow-up groups can be opened separately or compared together with the original work. An uncertain send is never automatically retried.

Chattering's SDK workers load an awaited checkpoint extension around potentially mutating tools. Known built-in read-only tools are skipped; Bash and unknown/custom tools are captured conservatively. Parallel execution is preserved. Private Git repositories under `~/.local/share/chattering/checkpoints/` store snapshots without touching your normal Git index, HEAD or branches. Editor/filesystem observations also create checkpoints. The existing per-file archive is retained.

Capture is bounded and can have gaps: it is not an atomic recording of every write. Unsupported/ignored/out-of-root files are not silently treated as captured. Older groups without checkpoints are labelled incomplete. Automatic capture currently covers managed SDK sessions, not standalone terminal agents; those agents' disk changes can still be observed. `CHATTERING_NO_CHECKPOINTS=1` disables capture; `CHATTERING_CHECKPOINT_DIR` changes its private directory; `CHATTERING_CHECKPOINT_MB` sets the compressed-blob budget (default 1024 MiB, with metadata/Git/journal overhead additional). Copies can retain deleted secrets and are not encrypted. See [checkpoint review architecture, limits and tests](design/36-checkpoint-reviews.md).

## New conversation

**+ new** in the top bar (key **C**, or the **+ new** pill on the phone home) opens a blank conversation from any view: no project memory, your home folder, pi's own defaults. It is a **draft** until the first message goes: no session file or Pi process exists yet, so the folder, the mode, the model, the reasoning level, the attached context, and instructions written for this one conversation all stay changeable. The line above the composer shows where it stands (`not started · runs in ~ · loose`); **setup** opens the folder picker and the instructions box; mode, reasoning, model, and Context are the same buttons as in any conversation.

The first send creates the session in the chosen folder with every choice applied and runs the message through the ordinary send path (one model, or several in parallel). The folder is the real working directory of the tools and decides which project the conversation joins, exactly as `cd X && pi` would — home, `~/Projects`, and temp folders stay loose; a project root or area joins that project (and inherits its default model). Choosing a project folder does **not** attach that project's memory; attach it deliberately with Context. Per-conversation instructions are a context item (`instructions` chip): they ride in the system prompt on every reply, preview like any other context, and are not a saved mode.

Drafts live in this browser (`localStorage`), survive reloads, and are listed under **Loose conversations → unsent drafts**; an untouched blank page leaves no trace. Images larger than the store keeps stay in memory for the page only, and the draft says so. A retry of the first send after a lost connection reuses the conversation already created (one hour, in the server's memory). If the session is created but the first run fails to start, the conversation opens with your words back in the composer and the error shown. Slash commands need a started conversation. See [design/40-new-conversation-draft.md](design/40-new-conversation-draft.md).

## Project setup

Use **+ project** to create a new folder or add an existing folder. Setup never starts an agent. Existing folders keep their names and contents. The project page offers **Start conversation** and a separate **Edit project purpose** action.

The form keeps entries after errors and supports keyboard and touch input. New folders show their resulting path and Git setting before creation. Purpose saves check for newer text before replacing it.

This change needs matching server and frontend code. Wait for active work to finish, restart Chattering, then reload. The form blocks setup writes to an older server. See [design/30-project-setup.md](design/30-project-setup.md) for checks and trade-offs.

## Project folds

A "project" is a name computed from a conversation's working directory. Git worktrees and second clones would split one project into several, so folds collapse raw names into one canonical project. Memory, epics, briefings, search, and the Gantt all follow the canonical name.

- **Automatic worktree folds.** A conversation inside a linked git worktree counts for the main worktree's project. The server probes `git rev-parse --git-common-dir` per conversation directory and caches the result in `~/.cache/chattering/project-folds.json` (derived; safe to delete).
- **Manual folds.** The project overview has `⇄ fold into…`: pick a target, one confirm line, done. The smaller project folds into the bigger one by default; `flip` swaps that. Manual folds live in `~/notes/chattering/projects/aliases.json` (user data). A self-alias (`"foo": "foo"`) pins a name against automatic folding.
- **Fast fold, no history.** The folded project's memory directory is deleted; the next memory build absorbs the merged conversation set. A fold is always reversible from the `contains … ✕` chips on the overview — only grouping changes, never source files.
- **Suggestions.** Quiet chips propose folds from evidence: same git remote (one star per remote group around its biggest member) or a name twin that git does not refute. Dismissing a pair is remembered. Overviews show at most three.
- API: `GET /api/project-folds`, `POST /api/project/fold {from,into}`, `POST /api/project/unfold {name}`, `POST /api/project/fold-dismiss {from,into}`.

## Epics

An epic uses distilled notes when they exist. It summarizes other selected conversations once and caches that evidence.
Large conversations are split into large sections near 80% of the model context limit. Section evidence is cached and merged.
If the provider rejects an estimated section, the app splits only that section again and retries it.
Very large epic evidence sets use chronological timeline drafts before the final merge.
It then creates chronological phases, outcomes, the current state, and open questions.

- The epic markdown lists full file paths for each source conversation: the original transcript (raw JSONL), the extracted conversation (JSON), the distilled note, and a Chattering link. A model that reads the epic can follow these paths to learn more.
- Epic metadata is stored in `~/.cache/chattering/epics.json`.
- Epic markdown is stored in `~/notes/chattering/epics/`.
- The exact evidence inputs for each new epic build are stored in `~/.cache/chattering/epic-inputs/`.
- Rebuilding keeps the same epic file and includes all previous conversations.

## License

Chattering's original code and documentation are licensed under [Apache 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution and scope. Third-party components keep their own licenses and notices.

## Config

- `PORT=8000 node server.js` changes the port (default 7433). `CHATTERING_CACHE_DIR=/tmp/x` moves the derived caches (index, search, file ledger) — handy for running a second instance against the same transcripts.
- `POST /api/rescan` forces a full rescan.
- Open **settings** (key `,`) to pick the Pi model used for notes, evidence, epics, titles, and project memory. The list comes from `pi --list-models`. The choice is stored in `~/.config/chattering/settings.json`. The **claude-code** provider uses your local Claude Code login and the `claude-code-fable-5` Pi extension.
- A memory-model call stops after two minutes without output. Three failed calls pause automatic work for 10, then 20, then at most 30 minutes. One manual action can test the model during a pause. Failed memory leaves retry after the same 10/20/30-minute delays. The jobs panel shows the pause, and `~/.cache/chattering/memory-model-health.json` keeps it across restarts. Set `CHATTERING_MODEL_ACTIVITY_TIMEOUT_MS` to change the two-minute silence limit.
