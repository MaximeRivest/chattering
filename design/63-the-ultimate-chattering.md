# 63 — The ultimate Chattering, and what rat and MRMD should be to it

*2026-09-22. A study, not a decision: it ends with the decisions it needs.
Written after a day that took notebooks in Chattering from "cannot answer
an input prompt" to live output, prompts, Run buttons, progress, variables
and kernel controls — each step touching rat, MRMD and Chattering at once.*

> **Status, 2026-09-28.** D5 is decided (Maxime, conversation 01a0ea09):
> **Chattering is the product; MRMD is its document library, not a product
> of its own.** The experiences merge, the software stays in parts — see
> "Rules of the parts" below. D3 is done and D1, D2 are partly done; the
> roadmap carries a status per step. The UX consequences are in
> [design/78](78-a-place-to-think.md).

## The question

Maxime owns three projects that each describe themselves as the place
where people and agents work:

- **Chattering** — "a calm, local-first workspace where conversations,
  files, runnable documents, and a real browser form one continuous working
  environment for people and agents" (project intent, 2026-09-22).
- **MRMD** — "Electron, browser, phone, VS Code, and agent clients should be
  heads over shared editor, project, filesystem, and runtime contracts"; the
  near-term product is a browser-first writing app (mrmd-packages intent,
  2026-08-25). Its March vision, `mrmd-packages/markcov2.md` ("markco is your
  dev … powered by pi … doors, invites, yjs, teleport, e-ink, voice"), is
  almost word for word what Chattering has since become.
- **rat** — "one shared execution world across terminals, coding agents,
  VS Code, notebooks, Markdown documents, and MCP clients", including
  **PiRAT**, "a graphical Pi frontend in which conversations are editable
  mrmd documents" (rat intent, 2026-08-25) — also what Chattering is.

What is the best version of Chattering, and does it get there by using rat
and MRMD to their fullest — or not?

## Short answer

- **rat: yes, fully, and more than today.** rat's thesis (one live
  namespace, many clients) *is* Chattering's thesis (people and agents in one
  environment). Chattering uses a quarter of it: it sends commands, but never
  listens. The best Chattering hears every run on a kernel — an agent's, a
  terminal's, a colleague's — as it happens, and shows who did what.
- **MRMD: yes to the library, fully; no to the products.** The editor's
  surface, cell model, output renderers, project model, reading modes and
  comments are exactly what Chattering needs, and should keep flowing in.
  The full 4.5 MB bundle, the Electron app, the server, the cloud platform
  and the separate AI server should not be adopted: they duplicate what
  Chattering already does better and carry debt MRMD's own review names.
- **The three stop competing.** rat is the execution layer, MRMD is the
  document library, Chattering is the product. The overlap (three
  "workspaces", two pi frontends, two rat adapters, two remote-access
  stories) is the real cost today, more than any missing feature.

## What the ultimate Chattering is

From the intent, made concrete. One ordinary day:

1. On the phone, Maxime asks an agent to analyse last month's runs. The agent
   works in `py@analysis`, a rat kernel.
2. At the laptop he opens the notebook the agent is writing. He sees the
   agent's cell running *now* — its output streaming under the cell, marked
   "agent · running · 40s" — and the variables drawer shows the dataframe the
   agent just loaded. He did not ask for any of this; it is just visible.
3. He edits a cell and runs it. Same kernel, same `df`. The agent, on its
   next step, sees his change in the namespace (and in the document).
4. A plot appears under a cell as an image, saved beside the notebook, not as
   a marker line.
5. He selects a paragraph and asks for "tighter"; the edit arrives as a
   pending change he accepts, and the provenance ledger records it as an
   agent edit at his request.
6. A colleague joins through a door; she types in the same document, runs a
   cell, and her run is marked with her name — in the notebook, in the
   kernel's activity, in the ledger.
7. On the e-ink tablet at night, he reads the notebook in read mode: no
   buttons, no motion, results as written.

Everything in this list either exists in one of the three projects already,
or is a small step from something that does. None of it exists *together*.

## The three projects today (evidence)

| | Chattering | rat | MRMD |
|---|---|---|---|
| Lines (approx.) | 70k (app.html 17k, server.js 16k) | 22k Go + 16k VS Code extension | editor 68k; electron 158k; server 15k; ai 3k; cloud 11k |
| Last activity | daily | daily | editor: daily, *driven by Chattering*; electron/server/ai: 2026-03-19; cloud: 2026-03-08 |
| Real daily use | yes (Maxime, family, devices) | yes (CLI, agents, VS Code) | through Chattering and VS Code only |

Findings that shape the answer:

1. **rat is cheap to call; that is not the problem.** Measured on lambda:
   `rat resolve` 7 ms, `rat status` 28 ms, `rat look` 30 ms, `rat run` 51 ms,
   `rat doctor` 94 ms. Design 41's rule ("no MCP client, no kernel state in
   this server; pass through to rat") costs nothing noticeable.
2. **rat already broadcasts everything Chattering lacks.** Every kernel has
   an event bus (`rat/internal/mcpserver/eventbus.go`): `run_started`,
   `run_output`, `run_waiting`, `run_ended`, `look_called`, `ctl_called`, each
   with the caller's name, plus a replay buffer for late joiners. Chattering
   cannot receive it: the CLI has no "follow" command, and design 41 keeps
   Chattering off MCP. This is the single biggest unused capability.
3. **Agents already share kernels with people — invisibly.** Pi agents run
   code through the `rat` CLI (the `rat` skill, `~/.pi/agent/AGENTS.md`,
   `cell.ts`). Today, for example, an agent ran cells in `py@lm15-python`
   while Maxime used the same kernel from Chattering. Nothing showed it, and
   rat's caller name would have said only `rat` for both.
4. **Two rat adapters for MRMD exist.** VS Code's (`createRatRuntime`,
   `rat/vscode-rat/media/mrmdEditor.js`, ~150 lines inside a 1,610-line
   webview script) and Chattering's (`runDocCell`, `/api/doc/*`). They
   differ: VS Code writes output as it streams; Chattering shows it live and
   writes once. The same notebook behaves differently in the two editors.
5. **MRMD's own runtime client is out of date.** The protocol spec says "MCP
   is the primary interface" (`spec/mrp-mcp-profile.md`, 2026-03-28), but
   `mrmd-editor/src/mrp-client.js` still speaks the old REST API. The full
   editor cannot talk to rat without a host adapter.
6. **The full MRMD editor carries known debt.** Its own review (EPICS.md,
   2026-08-25): "three products in a trench coat" — a 3,000-line `index.js`
   with 150+ methods, three markdown parsers, a 3,079-line output overlay,
   and a recommendation to split `shell/` and the AI UI into separate
   packages. Adopting the full bundle means adopting all of that.
7. **The light bundle is working — and busy.** Seven releases in four weeks
   (0.9 → 0.15), every one driven by Chattering. MRMD's editor is, in
   practice, being developed as Chattering's editor. That is healthy if it is
   the stated plan, and wasteful if MRMD is also meant to become a separate
   product with its own shell.
8. **Plots are lost in Chattering.** rat saves `plt.show()` figures as PNGs
   and prints `__RAT_PLOT__:<path>`; VS Code renders them
   (`vscode-rat/src/queue.ts:897`); Chattering prints the marker as text.
9. **Two pi frontends.** VS Code's PiRAT session editor (4,500 lines across
   `piSessionEditor.ts` and its webview) and Chattering both read, render and
   continue pi conversations.
10. **Two remote stories.** rat's network vision (`runanything.dev` tunnels,
    `rat py@gpu`) and Chattering's doors, Tailscale addresses and machine
    switching both answer "use a machine that is not this one".

## The layers

```
              people · agents · devices
                         │
   ┌─────────────────────▼──────────────────────┐
   │ Chattering — the product                    │
   │ conversations, agents, files, review,       │
   │ memory, people, doors, devices, provenance  │
   └───────┬──────────────────────────┬─────────┘
           │ hosts                    │ drives
   ┌───────▼─────────────┐    ┌───────▼──────────────────┐
   │ MRMD — the library   │    │ rat — execution & agency │
   │ editing surface,     │    │ kernels, environments,   │
   │ cells, outputs,      │◄──►│ activity & events,       │
   │ modes, project model │    │ runtimes beyond code     │
   │ + one rat adapter    │    │                          │
   └──────────────────────┘    └──────────────────────────┘
       also hosted by VS Code        also used by terminals,
       (the browser-only app is      agents, VS Code, any
        dropped: D5, 2026-09-28)      MCP client
```

## Rules of the parts (2026-09-28)

One product for people, separate parts in the code. Each rule exists to keep
the parts honest while the experiences merge.

1. **Dependencies point one way.** Chattering loads MRMD and drives rat;
   MRMD never knows it runs inside Chattering. When the editor needs
   something (run a cell, resolve an asset, draw a diagram, call a model),
   it asks its host through `document-host-services.js` and the options of
   `createDocumentEditor`, as it does today.
2. **The file format is the contract.** Plain Markdown, the `rat:` front
   matter, ```` ```output ```` fences and `_assets/generated/`, defined once
   in `rat-notebook.js`. Any change to it is a versioned change of that
   module, never a host-side special case.
3. **Hand-over by version.** Chattering serves a numbered copy
   (`vendor/mrmd-document/<version>/`) with its README changelog; an editor
   change reaches Chattering only as a new number. Old numbers that nothing
   serves are deleted (design/32 already noted 5 MB of them).
4. **Keep a second host.** rat's VS Code extension also hosts the editor
   and vendors `rat-notebook.js`. It is the test that the library is a
   library: a Chattering-only shortcut inside MRMD shows up as breakage
   there.
5. **Large abilities live in Chattering or rat, not in the editor.**
   Server-side runs, agents writing into the shared text, permissions and
   memory belong to Chattering (or rat for kernels). The editor displays
   them.
6. **Retire the products, keep the code as reference.** mrmd-electron,
   mrmd-server, markco-services, the mrmd daemon, mrmd-vscode and the
   mrmd-ai server are untouched since March 2026. Archive them (mark the
   repositories read-only with a pointer here); do not delete them — the
   daemon's "Yjs is the bus" design and the project model are still the
   blueprint for design/78's later steps.

**rat owns** what computes and who computed it: kernel identity, project and
environment resolution, execution, streaming, input, cancel, variables,
activity, events, and — later — kernels on other machines and non-code
runtimes (browser, mail, Slack), which are also agent tools.

**MRMD owns** how a Markdown document looks and behaves: editing, rendering,
cells and outputs (including rich outputs), reading/notebook/full modes,
comments, the project model (links, assets, navigation), and **one** rat
runtime adapter that every host uses.

**Chattering owns** everything a person does around documents and agents:
opening, saving, history, review, provenance, identity, permissions,
presence, devices, memory, and the agents themselves — including being the
backend that MRMD's AI commands call.

## Using rat fully — what that means

1. **Listen, not just speak.** Add `rat events --doc <notebook> <runtime>`
   to rat: the kernel's event bus as JSON lines, with replay, like
   `rat run --events`. Chattering keeps design 41's boundary (it still only
   runs rat) and gains everything: a cell run by an agent or a terminal shows
   "running" and streams under the right cell (matched by code); the
   variables drawer refreshes when *any* run ends; the kernel label shows
   busy/idle live. Rejected alternative: an MCP client inside Chattering's
   server — more code on Chattering's side, and the second client of a
   protocol rat already speaks for every other host.
2. **Name the caller.** rat labels a CLI run `rat`. Let a host name it
   (`RAT_CALLER`, or a flag): Chattering's agents already carry
   `CHATTERING_USER` in their environment, so a run can say "Maxime's agent"
   or "Lilly" instead of "rat". Attribution is a Chattering value (intent:
   "human identity … distinct from machine identity").
3. **Every language, not just Python.** Variables, restart and the kernel
   label are Python-only today because the doctor report is. rat's `look` and
   `ctl` are the same for every runtime; the drawer should follow the cell's
   language.
4. **Runtimes beyond code, later.** rat's runtime vision (browser, mail,
   SQL) maps onto Chattering's "real browser" and agent capabilities. Worth
   doing only when a real workflow asks; not a roadmap item now.

## Using MRMD fully — what that means, and what it does not

**Take, as the library grows** (each is an existing MRMD epic):

- **Rich outputs** (Epic 5.0/5.1, output registry): images first — this fixes
  finding 8 — then tables and HTML. Highest value per effort.
- **Modes** (Epic 3.3): read / notebook / full. Read mode is the e-ink and
  phone experience; notebook mode protects prose while cells run.
- **Comments in Markdown** (Epic 6): review annotations that survive in the
  file, which Chattering's review flow can use.
- **Project model** (Epic 11): links, assets, generated figures placed in
  `_assets/`, renames that fix links.
- **One rat adapter in MRMD**, used by VS Code and Chattering alike, so a
  notebook behaves the same everywhere (finding 4).

**Do not take:**

- **The full 4.5 MB bundle as it is.** 2.6× the light bundle on phones and
  e-ink, three parsers, the output overlay, and a second run queue and cell
  toolbar on top of the ones just built. Take its parts as they are
  modularised (EPICS recommends exactly this split), not the monolith.
- **The Electron app, mrmd-server and the cloud platform.** Dormant since
  March; Chattering covers their jobs (desktop via the browser and Android
  app, serving, doors, invites, sync).
- **The mrmd-ai server.** Keep MRMD's AI *interface* (the cursor menu,
  shimmer, accept/reject, several answers side by side) but let the host lend
  the backend, the way Chattering lends MRMD its mermaid renderer: in
  Chattering, AI commands are Chattering agents, with Chattering's models,
  permissions and provenance ledger.

## Decisions this needs (Maxime's)

Each with a recommendation; none is made by this note.

- **D1 — One notebook execution model.** Write output into the file as it
  streams (MRMD's VISION: "everything writes to it like a human would", VS
  Code today), or show it live and write once (Chattering today)?
  *Recommend write-once as the standard*: shared (Yjs) documents do not carry
  a stream of per-chunk edits to every peer, autosave and provenance see one
  change per run, and a reader never sees half-written results. Make it the
  MRMD adapter's behaviour so VS Code matches. Also settle the fence:
  `` ```output `` (today, portable) versus `` ```output:<execId> ``.
- **D2 — One rat adapter, in MRMD.** Move the adapter (run with events,
  input, cancel, variables, kernel controls) into mrmd-editor as a module
  both hosts load; each host only provides the transport (VS Code's message
  channel, Chattering's HTTP routes). *Recommend yes.*
- **D3 — How Chattering hears rat.** `rat events` (keeps design 41) or an
  MCP client in Chattering. *Recommend `rat events`.*
- **D4 — One pi frontend.** Keep growing PiRAT in VS Code, or make
  Chattering the pi frontend and give VS Code a way to open a session in
  Chattering? *Recommend Chattering*: it is where the daily use, the
  multi-device work and the people features are. PiRAT's rendering ideas can
  move into Chattering's reader.
- **D5 — MRMD as a separate product.** MRMD's intent still names a
  browser-first, install-free writing app (Epic 12). Keep it as a real goal
  (then MRMD needs its own shell, and the library boundary must stay clean),
  or fold that audience into Chattering (a guest or local-only mode) and let
  MRMD be a library only? *No recommendation without knowing whether a
  no-install public product still matters to you* — it changes how much
  MRMD's shell code is worth keeping.
  **Decided 2026-09-28 (Maxime): fold.** "My product is Chattering, a better
  place to think with AI, and Markdown notebooks are key to that." MRMD is a
  library; its shells are retired (Rules of the parts, 6). "mrmd" stays the
  open name of the notebook format and editor, the way an editor library
  keeps its name inside a product.

**Status of the other decisions, 2026-09-28:**

- **D1** — the fence is settled: ```` ```output ````, older forms
  (```` ```output:<execId> ````, VS Code's status suffix) are read and
  replaced (`rat-notebook.js`). Chattering writes once per run. Whether
  VS Code's runner also writes once is not verified.
- **D2** — half done. The format rules are one module (`rat-notebook.js`),
  and VS Code vendors it (0.16.0). The runner (`createNotebookRunner`) is
  used by Chattering only; VS Code keeps its own queue (`queue.ts`).
- **D3** — done: Chattering follows kernels with `rat events --json`
  (server.js, "kernel followers").
- **D4, D6** — not revisited.
- **D6 — Who reaches other machines.** rat's tunnels (kernels anywhere) or
  Chattering's doors (the whole workspace anywhere)? They are not the same
  thing: Chattering on lambda already reaches lambda's kernels; rat's
  network matters when the kernel should live on a third machine (a GPU box
  that is not the Chattering host). *Recommend: Chattering owns people and
  devices; rat owns kernels on other machines, when that need is real.*

## A roadmap, each step useful on its own

1. **`rat events` + caller names**, and Chattering showing other clients'
   runs and refreshing variables live. (rat M, Chattering M)
   *Done 2026-09-22 (rat `events`, Chattering kernel followers).*
2. **Plots in Chattering notebooks**: read `__RAT_PLOT__`, show the image
   under the cell, save it beside the notebook. A stopgap until step 4 — but
   plots are the most common notebook output. (S)
   *Done (plots in `_assets/generated/`, named by content).*
3. **The shared rat adapter in MRMD** (D2), then VS Code switches to it.
   (M, then M) *Half done: see D2.*
4. **Output registry** (MRMD Epic 5.0/5.1) in the light bundle: images,
   tables, HTML outputs. (L)
   *Mostly done in 0.24.0: ordered rich displays, images, sandboxed
   interactive embeds. Tables as tables: not yet.*
5. **Read / notebook / full modes** (Epic 3.3) in Chattering, read mode on
   e-ink and phone by default. (S–M) *Not started.*
6. **AI commands with a host-lent backend** (MRMD's menu, Chattering's
   agents and ledger). (M) *Done (0.20.0 and earlier; outcomes in
   `ai-feedback.jsonl`).*
7. **Variables and kernel controls for every language** (rat's look/ctl are
   already uniform). (S) *Mostly done: Python, R, Julia, shell and
   JavaScript cells run; R and Julia kernels landed 2026-09-27.*
8. **Project model** (Epic 11) when links and assets become daily pain. (L)
   *Not started; now step 4 of design/78.*

Not on it: switching to the full bundle, reviving mrmd-electron, mrmd-server
or markco cloud, the mrmd-ai server, rat's network, non-code runtimes. Each
stays possible; none is needed for the day described above.

## What would change this answer

- **If VS Code becomes the main place Maxime works**, PiRAT and the full
  MRMD editor inside VS Code matter more than Chattering's own surfaces (D4
  flips).
- **If a no-install public writing product is a real goal** (D5), MRMD needs
  its own shell again, and the library should be cut so both products stay
  healthy — slower for Chattering in the short run.
- **If the full editor's debt is paid** (Epics 1, 2, 5 and the package
  split), taking larger parts of it becomes cheap, and the "take parts, not
  the monolith" rule simply means taking more parts.
- **If rat's CLI grows slow or noisy** under many hosts (events for every
  keystroke-driven completion, say), an MCP client in Chattering becomes
  worth its code (D3 flips).

## Sources

- Chattering: design 41 (notebooks and the rat boundary), design 61 (the
  name), project intent (records, 2026-09-22), `vendor/mrmd-document/README.md`
  (0.9 → 0.15), conversation 01a03882 (2026-08-25: why the light bundle — "keep
  MRMD replaceable … do not copy modules"; runtimes and Yjs "deferred").
- rat: `docs/README-vision.md`, `docs/runtimes-vision.md`,
  `docs/network-vision.md`, `ROADMAP.md`, `KERNEL-PROTOCOL.md`,
  `internal/mcpserver/eventbus.go`, `vscode-rat/media/mrmdEditor.js`
  (`createRatRuntime`), `vscode-rat/src/queue.ts` (plots), rat intent (records).
- MRMD: `markcov2.md`, `DOCS-OWNERSHIP-AND-MIGRATION.md`,
  `spec/mrp-mcp-profile.md`, `mrmd-editor/docs/EPICS.md` (review and Epics
  3, 5, 6, 11, 12), `mrmd-editor/src/mrp-client.js`, `src/cells.js`,
  mrmd-packages intent (records).
- Measurements: rat CLI timings on lambda, 2026-09-22 (above).
- Today's work that tested the boundaries: rat `81c1722`, `30b642b`;
  mrmd-editor `93da1a6`, `41fd0fa`; Chattering `6db5d63`, `c69a3eb`,
  `a5169f1`; lm15 `ff26085`.

*Records and project intents quoted here are AI-written summaries of
conversations; they say what was said and planned, not what was decided.*
