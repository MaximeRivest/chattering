# 67 — Artifacts (proposal)

Status: **built** 2026-09-23 (all five phases; publishing waits for a public
domain). Builds on `65-open-webui-study.md`, `66-one-tree-one-head.md` and the
Claude / ChatGPT study of the same day (conversation 01a0ce59).

## As built

| Piece | File |
|---|---|
| Preview origin: capabilities, policy, MCP Apps sandbox proxy, view kit, file serving from disk or a version | `preview.js` (listener in `server.js`, port 7435; TLS 7445 beside the LAN one; Tailscale Serve 8443) |
| Versions of artifact folders, binary assets included; loose folders too | `checkpoint-store.js` (`artifact_scopes`), `checkpoint-extension.js` |
| Endpoints: `/api/artifacts/config`, `resolve` (versions on the head's path), `widget`, `blob`, `declare` | `server.js` |
| Tools `artifact` and `show` for every web session | `extensions/artifacts.ts` |
| Widgets, cards, code previews, the panel, the MCP Apps host | `artifacts.js`, `artifacts.css`; hooks in `conversation-reader.js` and `app.html` |
| Slides: the format for the model, and the viewer | `artifact-types/slides/SKILL.md`, `viewer.html` |
| Hardening: browser requests another page starts are refused | `server.js` (`Sec-Fetch-Site`) |
| Tests | `test/artifacts.test.js`, `test/checkpoints-review.test.js` |

Decisions taken while building, with their reasons:

- **Widgets go through the MCP Apps sandbox proxy** (host sends the HTML by
  `postMessage`), exactly as the spec requires of web hosts, so MCP servers'
  own interfaces can use the same host later. **Full artifacts load by URL**
  (they are several files with relative links); the panel talks to them
  directly with the same messages.
- **Stateless signed capabilities** (HMAC, 30 days, secret in
  `~/.local/share/chattering/preview-secret`) instead of an in-memory token
  table: links survive restarts and history; access is re-checked on every
  request, so revocation still works at once.
- **Network open by default** (`artifactNetwork: 'open'`), per the trust
  default; `libraries` is one setting away. Plugins are always off; only
  Chattering's own addresses may frame a preview (`frame-ancestors`).
- **`ui/message` fills the message box instead of sending**: a page cannot
  start a model run by itself. `ui/update-model-context`, `tools/call` and
  `resources/read` answer "not supported yet" (no MCP servers yet).
- **Widgets appear when their tool call is complete**, not while streaming
  (`tool-input-partial` is not sent): simpler, and the HTML then comes from
  the saved conversation, so a reload shows the same thing.
- On a phone the panel is a full-screen sheet opened from the card; it never
  opens by itself there.
- **The conversation keeps 420px beside the panel.** The dragged width is a
  wish; the column is that wish fitted to the window now (`--art-col`, a CSS
  `clamp`), so a width saved on a big screen, or before the window shrank,
  cannot crush the conversation and its composer to a sliver (it did: one
  letter per line). When list, 420px and the panel's 320px do not fit side by
  side (under 1028px, or 740px with the list folded) the panel lies over the
  conversation like the Files panel, and the files square steps aside
  instead of landing on the list. The head wraps by the
  panel's own width (a container query), not the window's.

**Since design/83 (2026-09-29)** the panel is also where a conversation's
files open beside it: the file view itself (kind `document`), one step's
change (kind `change`), and a Markdown or text artifact at its current
version in the real editor instead of a read-only page (older versions
stay pages to read). ⇄ swaps which side is wide; see design/83.

## Finding artifacts later (the library)

No store and no scan. Each conversation's index entry carries its artifacts
(`artifacts` in `indexFile`: files by absolute path, the newest declaration
naming them; widgets by call; failed calls excluded), computed whenever the
watcher re-indexes the conversation, like its title and counts. The entries
reach the browser with the conversation list and its live updates, already
filtered by what the person may see, so every list below is a filter over
data the page holds.

- **Right panel → Artifacts** (beside Files, same All / Project switch):
  newest first, kind icon, project and conversation, search, all / files /
  inline. Opening one opens its conversation on the card that made it
  (moving the head there if it was on another branch) and the artifact in
  the panel. The artifact replaces the Files list; one right panel at a time.
- **Project page**: the nine newest, and "all" to the panel scoped to the project.
- **Files list**: a ◧ on files that belong to an artifact; it opens the artifact.

Details: a file artifact declared in several conversations is one item (the
newest opens it; the count is shown). Mirrored conversations are left out
(their files live on another machine). Entries indexed before this existed
are re-read once at start, only for files changed since the tools shipped
(`ARTIFACTS_SINCE`). The conversation list's ETag now includes the server's
boot id and an index revision, so a re-derived entry reaches browsers that
hold a cached list.

Not done: thumbnails (an icon per kind instead; a real picture would need a
headless browser per artifact), and a disk check per row (a deleted artifact
still lists; opening it says the files are gone).


## What the study showed

Two sizes, in both products:

| | Claude | ChatGPT |
|---|---|---|
| **Small, in the conversation** | tool `visualize` → MCP Apps widget, `<hash>.claudemcpcontent.com` | "app block", `app-block-<hash>.web-sandbox.oaiusercontent.com` |
| **Full, in a side panel** | files written by the model (`index.html`, or `deck.json` + `slides/*.html`), served versioned at `<artifact-id>.frame.claudeusercontent.com/_f/<version>/`, optional typed viewer app (`artifact-type/app.js` + `SKILL.md`) and a capability runtime (db, files, comments, room, downloads) | a real site built and tested in the agent's container, deployed to `<name>.<user>.chatgpt.site`; real Office files rendered on canvases by an in-page renderer |

Shared mechanics: HTML runs on **its own site** (a separate registrable
domain, one sub-address per artifact), in a **double iframe** (a thin proxy
page on the sandbox domain receives the HTML by `postMessage` and writes it
into an inner frame), with `allow-scripts allow-same-origin` (safe because the
origin is not the app's), a **CSP allowlist of public CDNs**, and a host
**design kit** that a skill tells the model to use.

## What Chattering already has

| Piece | Where | Use for artifacts |
|---|---|---|
| One tree, one head | `conversation-tree.js`, `66` | Which version of anything you see |
| Capability-URL asset route | `file-media.js` `PreviewAssets`, `/api/file/preview-assets/<token>/…` | The serving pattern: unguessable, folder-scoped, expiring, re-authorised per request |
| Sandboxed HTML preview | `html-preview.js`, `file-viewers.js` | Static preview of a file (scripts off); stays for untrusted views |
| Checkpoints | `checkpoint-store.js`, `checkpoint-extension.js` | Exact workspace tree **after every tool call**, as git trees keyed by session + call id |
| File history | `file-archive.js`, `/api/file-history/*` | Per-file versions (text only) |
| Viewers | `file-viewers.js`, `live-file.js`, MRMD | PDF, image, video, Markdown/notebooks, HTML source |
| Cards under answers | `ensureNotebookCards` | The pattern for artifact cards in the transcript |
| Agent's browser | `agent_browser` | An agent can open and test its own artifact |
| Doors, Tailscale Serve | `frontdoor.js`, `design/56` | Where a second address comes from |

What is missing: an artifact concept, a second origin, a side panel beside
the conversation, versions of binary assets, a widget protocol, and any
typed viewer.

## The model

**An artifact is never a new store. It is a view of something the
conversation already holds, at the head.**

1. **Widget** (small, in the conversation). A Pi tool `show` records the
   HTML **in the session** as its call arguments. It is therefore versioned
   by the tree for free: regenerate, branch, merge, and the widget follows.
   Rendered where the call sits, sized to its content.
2. **Code block.** An `html`/`svg` fence in an answer gets a **Preview**
   action (Open WebUI's rule: html + following css/js blocks form one page).
   Derived from the message text; no tool needed.
3. **Full artifact** (side panel). The agent writes **real files in the
   project** (`game/index.html`, `talk/deck.json` + `talk/slides/*.html`, a
   `.pdf`, a `.md` notebook) and declares them with the tool
   `artifact({ path, title, type })`. The declaration is a pointer in the
   session; the content stays on disk, in git, owned by the person.
   **Version on screen = the checkpoint after the last tool call on the
   head's path that touched that path.** Moving the head moves the version.
   When the head is at the conversation's end and the disk has not changed
   since, the panel shows the live disk (and reloads on change).

Why files and not a database or a hosted copy: the agent already works on
files; the person can open, edit, commit and keep them; Claude's model
(files + versions) fits Chattering exactly, and ChatGPT's (deploy) is a
publishing step we can add later on top of files.

## Serving: the preview origin

- A second listener in the same server process (default port **7435**),
  serving **only** `/a/<capability>/<version>/<path>` and the proxy page.
  It ignores cookies entirely; authority is the unguessable capability
  (as `PreviewAssets` does today), bound to person + conversation + path, and
  re-checked against current access on every request.
- Content comes from the checkpoint store (`git cat-file` of the snapshot
  tree) for a version, or from disk for `live`.
- Addresses, by where Chattering is reached:

  | Reached at | Preview origin | Isolation |
  |---|---|---|
  | this computer | `http://<artifact>.localhost:7435` | one site per artifact (Chrome and Firefox resolve `*.localhost` to this machine) |
  | Tailscale (`lambda.tail….ts.net`) | `https://lambda.tail….ts.net:8443` (Serve port 8443 → 7435) | **one** preview site shared by all artifacts; a different port only |
  | future public domain | `https://<artifact>.<user>.<preview-domain>` | one site per artifact, separate registrable domain (the Claude/OpenAI standard) |

  A setting holds the preview base; nothing else changes when a public
  domain exists.
- **Hardening the app side** (needed because a different port on the same
  host is *same-site*, and the HttpOnly `SameSite=Lax` cookie is still sent
  to the app from a preview page): cookie-authenticated API requests must
  carry `Sec-Fetch-Site: same-origin` (or `none`); anything else is refused.
  This is ordinary CSRF protection and is worth having regardless.
- Frames: widgets and full artifacts both use the double iframe (proxy page
  on the preview origin, inner frame written from a message), `sandbox=
  "allow-scripts allow-same-origin allow-forms allow-popups
  allow-downloads"`, and a CSP whose script/style/connect allowlist is the
  public CDNs (jsDelivr, unpkg, esm.sh, cdnjs, Google Fonts). Trust stays the
  default (Maxime, 2026-09-23); the allowlist is a setting, including
  "anything".
- Host ↔ artifact messages follow **MCP Apps** (JSON-RPC over `postMessage`:
  initialise with theme and size, the artifact reports its size, asks to
  open a link, to download, to send a message to the conversation). Using
  the open standard means MCP servers' own interfaces render in the same
  host later (TODO item 4). *To verify against the current spec before
  building.*

## The panel

- A right-hand pane beside the conversation (resizable split), the same slot
  as the Files panel (one right panel at a time). Header: title, **Version
  n of m** (writes on the head's path), live/at-this-point marker, reload,
  full screen, open in a browser tab, download, copy path, **Ask about
  this** (puts a reference into the composer). Phone: a full-screen sheet
  with back. E-ink: a full page, no motion.
- Contents by type, reusing viewers: web folder or `.html` → preview origin;
  `.md` / notebook → MRMD read mode; `.pdf` → PDF.js; image, video, `.svg`;
  typed artifacts → their viewer app.
- Transcript: an artifact card under the answer that declared it (the
  notebook-card pattern); clicking opens the panel at that version.

## Typed artifacts (after the general part)

A type = a skill + a viewer, shipped in `artifact-types/<type>/`:
`SKILL.md` (how to write the format, the design kit, how to test) and a
viewer served on the preview origin. First type: **slides** (`deck.json` +
one HTML file per slide, Claude's proven format), with present mode and
PDF export (Chromium print). Editing in the panel and `.pptx` export are
later steps.

## The agent tests its own work

The `artifact` tool returns the preview URL (and the Tailscale one). With
`agent_browser` the agent opens it, clicks, screenshots, and fixes before
answering — ChatGPT's strongest habit. A skill says when to do it.

## Versions of binary assets

Checkpoints skip images, fonts, PDFs and files over 2 MiB. A declared
artifact folder becomes a **checkpoint scope** (`approveScope` exists) whose
captures include binary assets up to a limit (proposal: 20 MB per file,
within the existing checkpoint budget). Outside declared folders nothing
changes.

## Limits to state

- Versions exist for Pi web and SDK runs (the checkpoint extension). Pi
  terminal runs and Claude Code conversations show the **live disk only**.
- Through Tailscale, all artifacts share one preview site (they could read
  each other's browser storage) until a public preview domain exists.
- A widget's HTML lives in the session file: large widgets make the
  conversation file larger (a size cap per call, e.g. 256 KB).
- Two branches writing the same folder: each branch's version is exact from
  its checkpoints; the disk holds whichever wrote last (the files-on-disk
  line of `66` phase 4 applies).
- Publishing (a public link) waits for the public domain and relay.

## Phases

1. Preview origin + capability serving from checkpoints/disk + app-side
   `Sec-Fetch-Site` hardening + Tailscale port.
2. Side panel with versions following the head; `artifact` tool; cards;
   code-block Preview.
3. Widgets (`show` tool) with the MCP Apps message shape; design kit + skill.
4. Binary assets in artifact scopes; agent self-test in the skill.
5. Slides type; later publishing.
