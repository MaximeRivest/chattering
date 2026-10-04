# 46 · Users, presence and multiplayer

Status: built 2026-09-19 (steps 1–6 below; the team-scale seams cut, the
team-scale features deferred). "As built" at the end records what landed
and every trade-off taken. The thinking above it is kept as written.

## Quiet self-presence

Conversation participant badges and live presence show other people, not the
viewer. The comparison uses the signed-in user id and roster merge aliases,
never names or initials; another device signed in as the same person is also
hidden. The profile/settings button and profile/roster management keep their
own identity displays. Stored authorship and read receipts are unchanged.

Shared composer and file-editor cursors follow the same rule. The editor gets
a filtered awareness view for decorations only: local state stays available,
the real provider still shares full awareness, and edits still synchronize
between the viewer's devices. Identity arrival or a merge refreshes existing
markers without rewriting shared documents. Other people's presence bubbles
are deduplicated per person; their individual editing cursors remain visible.

## Profile settings update

The signed-in user's initials or picture are now the Settings button (first
in the desktop panel footer). Settings → your profile edits the existing
user's name, optional custom initials and picture; it does not create a new
identity or change any role, group, credential or authorship. Additional people
still join through Settings → people and its existing invitation controls.

The browser accepts PNG/JPEG/WebP up to 12 MB, center-crops to a 128×128 PNG,
and previews before Save. Use initials removes the picture when saved. Draft
fields survive settings repaints. A member may change their own profile; the
existing roster-management rules still gate changes to other users.

The private roster stores the thumbnail as `avatar`. Validation limits it to
96 KiB and a PNG header with dimensions at most 256×256. Public user records
contain only the content hash, not image bytes, so presence and attribution
stay small. Authenticated `GET /api/users/avatar?id=…&v=…` serves that version
as `image/png` with private caching and `nosniff`. No external image URL or SVG
is accepted. A failed image falls back to initials. Name and picture are local
to this install; machine handoff does not transfer the image bytes.

This requires the updated server as well as the UI. Do not restart it during
active runs merely to enable pictures; the profile form reports an older
server rather than claiming the photo was saved.

## What Chattering is today, seen from the question "who did this?"

Every fact below shapes what a *user* can be. None of them are opinions.

1. **An install is a Unix account's home directory on one host.** Conversations
   are Pi and Claude session files under `~/.pi/agent/sessions` and
   `~/.claude/projects`; notes, vouches, the ledger and settings are files under
   `~/notes/chattering`, `~/.config/chattering`, `~/.cache/chattering`. Agents run as
   that account, with that account's API keys and git identity. When Maxime
   opens Lilly's Chattering, everything he does happens *as her account*: the file
   lands in her home, the agent spends her key, `git` records her name. The
   files cannot tell people apart because the machine cannot.

2. **There is no identity, only admission.** One token per install
   (`~/.cache/chattering/lan-token`). Whoever has it in a cookie or `Bearer`
   header is "in". A request from loopback without proxy headers is "local"
   and skips the token. The server cannot distinguish Maxime's phone from
   Lilly's laptop from the e-ink tablet.

3. **Machines are islands that know each other's address and token.** Pairing
   (`/api/machines/connect`, `/api/machines/register`) is symmetric: paste one
   link, both installs remember the other with a token. "Going to Lilly's
   machine" is a plain navigation to her URL with her token in the query; the
   page then talks only to her server. No data is federated.

4. **Live updates are one broadcast channel.** `/api/events` is server-sent
   events, broadcast to every connected browser, with no idea who is behind
   each connection. There is no presence.

5. **A message enters a conversation two ways.** Web runs: `pisdk-runtime.js`
   calls `session.prompt(text)` in a worker; Pi writes the user message into
   the JSONL. Terminal conversations: the server pastes the text into the Pi
   TUI running in Alacritty through the bridge. Neither path records who typed.
   Pi's session format has a hook for this: `custom` entries
   (`sessionManager.appendCustomEntry`) live in the same tree as messages;
   Chattering already writes one per mode switch (`extensions/modes.ts`).
   Claude Code sessions are read-only here.

6. **Files are single-player with a lock.** The editor is the vendored
   `mrmd-document` bundle (CodeMirror), which deliberately excludes Yjs,
   awareness and every collaboration part. Saves carry `baseSha`; a mismatch is
   refused. The ledger (`fileledger.js`) records `actor ∈ {ai, human, git,
   external}` and `input ∈ {keyboard, voice, pen, paste, …}`. "human" is
   anonymous. Vouches (`design/24`) are anonymous human assertions too.

7. **Drafts and the compose box are per browser** (`localStorage`,
   `conversation-draft.js`). Two people cannot see the same draft even on the
   same install.

8. **A project is a folder name.** Registered in `~/notes/chattering/projects.json`,
   matched by session `cwd`. No owner, no visibility.

9. **Admitted means powerful.** `/api/exec` runs any bash line as the account;
   agents read any file; the `chattering` CLI and the Pi records tools run as the
   Unix user and see every conversation. 187 `/api/*` routes; 9 places check
   `isLocalRequest`. There is no middle tier between "outside" and "the
   account".

10. **Tailscale cannot name people here.** Every device, Lilly's PC included,
    joined under one Tailscale login, so `Tailscale-User-Login` says the same
    name for everyone. The identity has to be Chattering's own.

## The concept

A **user** is a person: the one typing in a compose box, editing a file,
vouching a note, taking control of a browser. A **machine** is an install:
where agents run and where files live. Users are orthogonal to machines:
the same person is the same user on every install, and an install can host
any admitted user.

Three consequences that should be stated plainly and never fudged:

- **The install owner sees everything on their install.** The files are in
  their home directory; the agents run as them. A permission that claims to
  hide project X on Lilly's machine from Lilly would be a lie. Permissions
  are about *other* users on an install: Lilly on lambda, Jacob on lambda,
  Maxime on Lilly's PC.
- **Permissions between admitted users are polite walls, not vaults.** Any
  admitted user can ask an agent to `cat` a file, or run `/api/exec`. Real
  walls would need agents sandboxed per user and every file route gated —
  a different product. Polite walls are still worth having: they prevent
  accidental reading, keep lists uncluttered, and express intent. The UI must
  say "hidden from", not "protected from".
- **Attribution is a claim the server makes**, and its quality is that of the
  sign-in. Which is why identity comes before presence, and presence before
  permissions.

### User record

```json
{ "id": "u_3f9c…", "name": "Maxime", "glyph": "M", "color": "#…", "createdAt": "…" }
```

`id` is random at creation and never changes; `name` is display only. The
roster lives at `~/.config/chattering/users.json` per install, and is a plain
file like everything else. One roster entry is marked `owner`: the person
whose account this is. On first run, the roster is created with the owner
named after the account (Maxime on lambda and XPSwhite, Lilly on lilly-pc),
and the local console *is* the owner.

### Sign-in

Two candidate designs; the differences matter.

**A. Per-user credential per install.** Each roster entry can issue an invite
link (`https://lambda…/?user=<secret>`), exactly how the LAN token works
today, but the cookie now names a user. Simple, secure (a real bearer
secret), and the tablet and Android app keep their token flow unchanged: the
existing LAN token becomes the owner's credential at migration, so nothing
already signed in breaks. Cost: one paste per (person, install). Loss of a
device = rotate that user's secret on each install.

**B. Device keypairs.** Each browser generates a key (WebCrypto); a person's
user is the set of their device keys; an install admits a key once. No
secrets travel, rotation is per device. Cost: WebCrypto key storage is per
browser profile and gets wiped with site data; the e-ink tablet's WebView
and the Android app need their own key store; enrolment is a click-to-approve
that needs a second admitted person or the console to be present.

Recommendation: **A**, plus one addition that gives the "orthogonal to
machines" feeling without a central server:

**Handoff between paired installs.** Installs already trust each other
completely (pairing shares the whole token). Give each install an Ed25519
key (`crypto.generateKeyPairSync`, no dependency) exchanged at pairing. When
a signed-in user clicks lambda → lilly in the switcher, lambda mints a
30-second signed handoff `{user record, exp}`; the navigation goes to
`https://lilly…/?handoff=…`; Lilly's install verifies lambda's signature,
upserts the user record into its roster if absent (so rosters converge
without a sync job), sets the cookie for that user, and lands on the page.
No paste. One user id everywhere. The trust assumption — "a paired install
may assert who someone is" — is the assumption pairing already makes today.

Two independently created "Maxime" entries (installs paired late) need a
"same person" merge in settings → users. Rare; keep the merge but do not
design around it.

### Authorization tiers

| tier | who | can |
| --- | --- | --- |
| console | loopback, no proxy headers | everything (unchanged) |
| owner | the roster owner, signed in | everything |
| user | any other admitted user | see and act on what is shared with them |
| nobody | no cookie | login page (unchanged) |

The single `hasLanToken` check becomes `identify(req) → {user, tier}` in one
place, and the request carries it. Every route that writes gets the user
handed to it; nothing else about routing changes.

## Attribution: who sent, who edited

Once a request carries a user, record it where the artifact lives:

- **Web-run messages.** Right before `session.prompt`, the runtime appends a
  custom entry `chattering-author {user, device, input}` meaning "the next user
  message is by…". It sits in Pi's entry tree, so it travels with the file,
  survives forks, and survives copying the session to another machine. The
  indexer (`indexFile`) reads it and sets `author` on the following user
  message, plus `participants` on the conversation.
- **Terminal-bridge messages.** The server does not own that file (the TUI
  does; two writers corrupt JSONL). A sidecar
  `~/notes/chattering/authorship.jsonl` `{key, ts, user, chars}` is matched to
  the next user message by time and length. Weaker, local to the install,
  and honest about it: the index marks these `author.via: "bridge"`.
- **Files.** `file_events` gets a `user` column (SQLite migration, nullable),
  `doc-edits.jsonl` a `user` field; `/api/file/save`, `/api/doc/save` and
  `/api/doc/commit` fill it from the request. Commits made by Chattering set
  `--author "Name <id@chattering>"`, so git, the one identity carrier every tool
  already reads, agrees with the ledger.
- **Vouches** get `user`; the trust label becomes "vouched by Maxime". This
  changes the meaning of `vouched` from "a human" to "this human", which is
  strictly more useful and costs one field.
- **Everything that exists today** is attributed to the install owner. That is
  the truth for nearly all of it and the best available guess for the rest.

"Conversations I have been in" is then a filter on `participants`, on the
home Gantt, the tree and search. Cheap once the index carries it.

## Presence: seeing each other

The SSE channel is already there; it only lacks a way in.

- Browser → server: `POST /api/presence` every ~5 s and on every route
  change: `{route, kind: viewing|typing|editing, position?}`. `route` is the
  conversation key, file path, project or `home`; `position` for a file is a
  line, for a conversation a message id. Typing is signalled by the composer.
- Server: in-memory `Map<connection, presence>`, keyed by the SSE connection
  (the heartbeat names its connection with an id the server gave at
  connect). Broadcast a compact diff on the same channel; drop on close.
- UI: a coloured bubble with the glyph, in the header (who is on this
  install), on tree and home rows (who is in that conversation), in the
  conversation header ("Lilly is typing…"), in the file gutter (a cursor mark
  at her line). The e-ink theme uses shape and initials, not colour.

This is per install: presence on lambda is not visible from lilly-pc. Cross-
install presence would be a small relay over the existing pairing
(`remoteJson` peer summaries every few seconds) and can wait until per-
install presence has proven useful.

## Multiplayer: two people in one compose box, one file

This is the part that changes the substrate, and it should be done once,
right, with Yjs — the mrmd stack (`yjs`, `y-codemirror.next`, awareness)
already solves cursors, selections and merges, and no one should write a
second CRDT.

What it costs, honestly:

1. **A Yjs runtime on the server.** The server must hold the authoritative
   `Y.Doc` per shared document, persist it, and merge disk changes into it —
   agents write the same files with plain `write`/`edit`, and those changes
   must appear in everyone's editor without clobbering typed text. mrmd-sync
   (now inside the mrmd daemon) already does the disk↔CRDT reconciliation.
   For Chattering that is either a vendored server bundle of Yjs (the project
   has no npm dependencies and it is a stated property worth keeping) or the
   first dependency. Vendoring is consistent with how the editor bundle
   arrived.
2. **A WebSocket endpoint.** The server already upgrades one path
   (`/api/speech/stream`); a `/api/collab/<doc>` upgrade with the y-websocket
   wire protocol is the same mechanism.
3. **A second editor bundle**, `mrmd-document` *with* the collaboration parts
   (or a flag in the same build). The current one excludes them on purpose;
   the exclusion was right until now.
4. **The compose box becomes a shared document.** A draft moves from
   `localStorage` to a server doc `draft:<id>`; the composer of an existing
   conversation gets `compose:<conversation key>`. Anyone signed in on that
   install and allowed to see the conversation can join it; cursors and names
   show through awareness. Send clears the doc and records the sender as
   author, with `coauthors` from Yjs per-client attribution when someone else
   typed part of it. Attachments (images, context) stay outside the CRDT:
   they are references, not text.
5. **Files.** The live editor keeps its history, ledger and Ask; only the
   text buffer changes from "mine, lock on save" to "shared, always merged".
   The `baseSha` refusal goes away for collaborative files, replaced by the
   ledger recording each user's contribution from awareness. Autosave to disk
   stays server-side, so agents reading the file see what people typed.

Order that keeps each step useful on its own: shared compose box first (small
doc, no disk sync, the thing Maxime described), then files.

Where the transcript is concerned: **never** put a conversation's JSONL under
a CRDT. It is Pi's append-only log with one writer. Multiplayer applies to
what people type *before* it becomes a message, and to files.

## Permissions: owners and privacy

Keep it small enough to be enforced in one module.

- **Subjects:** users, `everyone` (every admitted user on this install).
- **Objects:** projects (a folder), conversations (a session file), and
  through them notes, memory, reviews and file history *about* them. Loose
  conversations (no project) are their own object.
- **Rights:** `see` (list, read, search hits), `act` (send, edit, run,
  vouch), `own` (change sharing, delete, transfer).
- **Defaults:** everything is `see`+`act` for `everyone` (a household), the
  creator owns what they create, the install owner owns everything created
  before users existed and is always allowed everything. A project's setting
  is inherited by its conversations unless a conversation says otherwise.
- **Private:** the owner marks a project or a conversation "only me" or
  "me and Lilly". It disappears from lists, search, memory briefings and the
  home Gantt for others, and their `send`/`act` calls are refused.
- **Storage:** `~/notes/chattering/access.json` `{ "project:name": {...},
  "conversation:key": {...} }`, per install. Sharing does not federate:
  Maxime's setting on lambda says nothing about Lilly's PC, which has its
  own files and its own owner.
- **Enforcement:** one function `can(user, right, object)` in
  `access.js`, called at chokepoints, not per route: index listing and
  timelines, conversation read, `send`/`act`/`node/send`, file routes (path →
  project → object), search and semantic hits, records API when the request
  is HTTP with a user. The CLI and Pi tools run as the account and are not
  gated — this is the "polite walls" boundary, said out loud in the UI.

## Easy, hard, wise, unwise

**Easy (days each, each useful alone):**
- Roster, per-user credentials, `identify(req)`, owner migration from the
  LAN token, settings → users. The tablet and Android keep working.
- Attribution on web-run sends (custom entry), file saves, doc commits,
  vouches; `participants` in the index; the "mine" filter.
- Presence bubbles over the existing SSE channel.
- Handoff between paired installs (install keypair, signed 30-second claim).

**Medium:**
- Shared compose box on Yjs: server Yjs runtime, WebSocket endpoint, collab
  editor bundle, drafts moved server-side.
- Polite-wall permissions with `access.js` and the chokepoints.
- Terminal-bridge attribution (sidecar; inherently approximate).

**Hard:**
- Collaborative files with agent edits merging live (the mrmd-sync problem,
  redone inside Chattering's history/ledger model).
- Cross-install presence and roster sync beyond handoff.
- Real (not polite) permissions: per-user agent sandboxes, gating every file
  route and `/api/exec`. Not for a household; noted so no one mistakes the
  polite version for it.

**Unwise:**
- A central account server. Installs are islands that pair; keep it so.
- Users as Unix accounts. Then Maxime on Lilly's PC needs an account on her
  PC, and the agent could not act in her checkout for him.
- Claiming to hide anything from an install's owner.
- A CRDT of our own, or a CRDT over the transcript.
- Presence or permissions before identity is real; both would be built on a
  guess.

## Team scale: thirty people, three departments, one server

> **Update 2026-09-23 (conversation 01a0cb65):** "no to build" is superseded. A company hub serving every employee is now a goal (TODO item 7), to be built after the product is safe for strangers (TODO item 2). The analysis below still holds; the separation of identity from execution principal is the first thing to design.

Asked on the same day: is this the moment to think about admins, managers,
departments? Yes to think, no to build. The household version and the team
version differ in one thing that is architectural and in several that are
not. Decide the architectural one now; leave the rest as data shapes that
do not close doors.

### The one architectural fact

In a household, the person and the account the agent runs as are the same
thing, and that is fine: everyone in the house is trusted with the account.
In a company on one server, they must be different: **who you are**
(identity) and **what the agent runs as** (the execution principal: a Unix
user, its home, its groups, its API keys). Today Chattering collapses the two:
every agent is spawned as the service's account. That is why the household
plan can only offer polite walls.

Real walls on a shared server do not need a new permission system. Linux
already has one that every tool honours: users, groups, directory modes.
Departments are groups; projects are directories owned by a group; an agent
spawned as `lilly` in group `eng` can read `/srv/work/eng/*` and nothing in
`/srv/work/finance/*`, and so can `cat`, `/api/exec`, the records tools and
anything else. Chattering then *reflects* the filesystem's answer instead of
inventing its own. Auditable with `ls -l`. That is what the best sysadmin
would do, and why an ACL table in JSON would be the wrong choice for a
company.

What it costs, and why not now: the server would run as a service user with
the right to spawn as others (`systemd-run --uid` or `sudo -u`), session and
note files would move from one home to per-user or per-group trees, API keys
would be per principal (which is also how you bill a department), and the
indexer would read many trees with different rights. That is a second
deployment mode of the same program, not a fork. A household does not need
it; building it now would be building for a customer that does not exist.

The seam to cut now so it stays possible: every place that spawns or resumes
an agent (`startAgentRun`, `startProjectConversation`, the terminal opener,
delegation supervisors, `/api/exec`) takes an explicit **principal** from
the request's identity, even though in the household mode `identify()`
always maps every user to the one service account. One parameter threaded
through, resolved in one function. Skipping it means touching every spawn
site later, which is the rewrite this section exists to prevent.

### Data shapes that cost nothing now and keep the door open

- **Role is a field, not a flag.** `role: owner | admin | member`, not an
  `owner: true` boolean checked in twelve places. The household has one owner
  and members; a company has admins who manage the roster and rules without
  being the account. Same field.
- **Groups exist from day one**, even if empty: `groups: ["eng"]` on a
  user, and access-rule subjects are `user:<id>`, `group:<id>` or
  `everyone`. A manager seeing a department's conversations is then one rule
  (`group:eng-managers` has `see` on every project in `group:eng`), not a
  hierarchy feature. Hierarchy is groups plus rules; do not model an org
  chart.
- **The roster is loaded through one module** (`users.js: load(), find(),
  upsert()`), file-backed today. A company has a directory (an IdP, SSO,
  OIDC) and thirty rosters converging by handoff would be silly; the module
  boundary lets the source change without touching `identify()`'s callers.
  The install signing key from the handoff design is already the shape of
  "trust this issuer's claims"; an OIDC issuer slots into the same place.
- **Attribution is an audit log.** `authorship.jsonl`, `file_events.user`,
  `doc-edits.user`, vouches: append-only, per install. In a company it must
  be unwritable by members (a directory the service owns, not the user's
  notes). Keep the writer in one place so the location can move.
- **Per-user settings and keys.** Model choice, thinking level, voice, and
  later API keys are per user, not per install. The household needs the
  first three anyway (Jacob's settings vs Maxime's), so this is not extra.
- **Machines stay islands, conversations stay bound to one.** "Share a
  conversation so it runs on the computer with the right tools" is a link to
  that install plus the handoff identity, which the household design already
  gives. A company adds a directory of machines ("eng builds on
  build-01"); that is a list, not an architecture.

### What a team needs that a household does not, deferred with no regret

- Roster administration by non-owners; invitation flows; deactivation.
- Real isolation: spawn-as-principal, per-group trees, per-principal keys.
- SSO. Central directory. Admin views of usage per person and department
  (`usageanalytics.js` gains a `user` dimension from attribution for free).
- Retention and export rules; who may delete.

None of these change step 1. All of them get harder if step 1 hardcodes
"owner is a boolean", "identity is the account", or "the roster is a file".

## Order

1. Identity: roster, credentials, `identify`, owner migration, handoff. No
   UI change except settings → users and a name in the header.
2. Attribution + `participants` + "mine" filter + vouched-by.
3. Presence.
4. Permissions (polite walls), one module, chokepoints, honest labels.
5. Shared compose box on Yjs.
6. Collaborative files.

Each step lands as its own change with its own tests, and each is worth
having if the next one never comes.

## As built (2026-09-19)

Modules: `users.js` (roster, credentials, roles, groups, merge, handoff
keys), `access.js` (rules and `can`), `presence.js` (who is where),
`wsserver.js` (RFC 6455, server side), `collab.js` (Yjs documents over the
y-websocket protocol), `collab-client.js` and `people.js` (browser),
`people.css`. Vendored: `vendor/yjs-server/13.6.29` (Node) and the editor
bundle 0.12.0 with `mrmdDocument.collab`. Tests: `users`, `access`,
`wsserver`, `collab`, `users-server` (real server: sign-in, sharing,
presence, handoff), `people-app` (two people in a real browser).

### Identity
- Roster at `~/.config/chattering/users.json`, owner made on first run from
  `git config user.name` (else the account name). Owner credential = the
  install token, so every signed-in device keeps working. Members get
  invite links; secrets are stored hashed and shown once (like API tokens).
- `identify(req)` runs once per request; `req.identity` = `{user, tier}`.
  Local console = the account. `/logout` drops the cookie.
- Roles `owner | admin | member`, `groups` on each user, `aliases` for
  merged ids. Roster management by owner/admin; a member manages only
  their own links and name.
- Handoff: Ed25519 install key (`install-key.json`), exchanged at pairing
  (`publicKey` on machine entries; old pairings fall back to the token
  link and the switcher says so). `/api/handoff?i=` mints a 30-second
  claim; `?handoff=` verifies, upserts the person, issues a session
  credential (six kept per person).
- Trade-off: bearer credentials, not device keys — one paste per person
  per machine, mostly replaced by handoff. Stated in the thinking above.
- Trade-off: settings writes are owner/admin only; members read settings
  without other machines' tokens. A member cannot change the memory model
  of a machine that is not theirs; their appearance choices stay local.

### The principal seam
`principalFor(identity)` → `{user, spawnAs: null, env}`; `agentEnv(principal)`
threads it into every spawn (`startAgentRun`, fan-out, terminal sends,
draft starts, delegation resume). Today every principal runs as the
account with `CHATTERING_USER` / `CHATTERING_USER_NAME` in the environment.

### Attribution
- SDK runs: `pisdk-runtime.js` appends an `chattering-author` custom entry
  (user, input, coauthors) right before the user message. `parseFile`
  attaches it to the message whose parent it is.
- Bridge and rpc sends: `~/notes/chattering/authorship.jsonl`, matched to the
  next unattributed user message within two minutes (`via: bridge|rpc`).
  Weaker by design and labelled.
- Index entries carry `participants` and `createdBy`; `/api/session`
  returns resolved participants; the home "people" filter offers
  "mine" (I wrote into it, or nothing recorded and I own the machine).
- File ledger gains a nullable `user_id` column (migration, rows kept);
  human sessions group per person. `doc-edits.jsonl` and vouches carry
  `user`; the trust label says "vouched … by Lilly".
- Trade-off: a guest's Markdown commit gets `--author "Name <id@chattering>"`;
  the owner keeps their own git identity. Members are not made the git
  author of the owner's repositories by accident, and the owner's commits
  do not change.

### Presence
The `/api/events` stream names each browser (`hello {conn, me, users,
people}`); the page reports `route`, `kind` (viewing/typing/editing) and
position to `POST /api/presence`; the server broadcasts the whole book,
filtered per receiver by what they may see (a hidden conversation's key
never reaches someone it is hidden from). Bubbles in the header, "Lilly is
typing…" under the title, marks on conversation rows.

### Permissions (polite walls)
`access.json`; rules per project or conversation, mode `everyone | listed`,
subjects `user:` / `group:` with `see` or `act`, owners. Conversation rule
overrides project rule. Console, owner and admin see everything, always.
Chokepoints: sessions list (ETag includes the person and the rules
version), session read, tree, search (both stages), related, project page
and folds, files browse, file read/save, doc save/commit, vouch, exec
(cwd), node/send, conversation/send, act, fork, branch, retitle, distill,
the collab upgrade, presence. Not gated: the `chattering` CLI and the Pi
records tools (they run as the account) — the "polite walls" boundary,
said in the sharing dialog.

### Shared compose box
`compose:<key>` and `draft:<id>` are Yjs texts on the server, persisted
under the cache so a restart keeps what was typed. The composer keeps its
textarea (dictation, snippets, slash commands, shortcuts all talk to it);
`collabBindTextarea` keeps it equal to the shared text with the caret
shifted by remote edits, and other people's carets are drawn over it
through a mirror element. Sending records co-authors and clears the box
for everyone. Trade-off: a textarea binding instead of a CodeMirror
composer — the caret overlay is an approximation (it follows the mirror's
metrics), while the text itself merges exactly.

### Shared files
`file:<abs>` documents are created from disk when the first person opens
the file and dropped when the last leaves; the editor gets
`yCollab(ytext, awareness)` (cursors and selections for free). The disk
follows 400 ms after typing stops through the ordinary save path (history,
ledger, activity; the ledger row names the last person who typed). An
agent's write on disk becomes one minimal edit in the shared text, so
cursors survive. The Save button disappears ("Shared · saves as you
type"); Ctrl+S only refreshes the status. Trade-off: when the WebSocket
cannot be reached (old server, a proxy without upgrades), the editor falls
back to the single-player lock-and-save path unchanged. Spectators
(read-only sharing) see the text and cursors and cannot type.

### One copy of a shared file across reconnects (2026-10-04)
The rule above, "created from disk… dropped when the last leaves",
repeated whole notebooks. A page keeps its copy of the document across a
dropped connection (y-websocket does, to resync typing done offline). The
server dropped the file's document when its last viewer left (a Wi-Fi
blip, a laptop asleep) or lost it in a restart, and rebuilt it from the
disk text: the same text inserted again by a new author. The page's resync
merged its copy into that one, every character appeared twice, and the
quiet save wrote it to disk. Notebooks were hit most: kept open in the
side list, they stay joined for hours.

Now (collab.js):
- **A file's history is saved** under the cache (`collab/files/`) with the
  disk text it matches, and reopened instead of rebuilt; a disk change made
  while nobody had the file open becomes one edit on top. Reconnecting
  after a blip or a restart is then an ordinary resync, offline typing
  included. The history is saved before the 400 ms save writes the text,
  so the saved history is never older than the disk; the server notes the
  written text the moment the write lands (before history and ledger), in
  the saved history if the document left memory meanwhile. A history
  unused for 30 days is swept.
- **Lineages, the safety net.** Each history has an id; the page learns it
  and names it when it reconnects. A page holding another history (the
  saved one was lost or swept) is not merged: the server sends its copy,
  the page replaces its own in one transaction (the editor and its binding
  stay; the old items reach the server only as deletions) and only then do
  they sync. If the page's text differed, a banner offers "Put my version
  back" (one undoable edit) or a copy. A page that does not speak lineages
  (a tab from before) is admitted only if it holds nothing the server
  lacks, else closed with 4409 until reloaded.
- Typing within 400 ms of the last viewer leaving, or of a stop, now
  reaches the disk.

Trade-offs: the cache holds a copy of each recently edited file's text and
history (deleted files too, until swept); a large notebook's history is
written whole at each pause in typing; the composer has no banner (a reset
there replaces the box's text silently, and needs a lost saved history);
an open tab from before this change cannot edit shared files until it is
reloaded, which the restart toast already asks for.

### Protocol and dependencies
`wsserver.js` is a small server-side WebSocket implementation (masked
client frames, fragmentation, ping/pong, close, size limits; no
extensions) rather than an npm `ws`: the project keeps zero dependencies,
and the browser talks the stock y-websocket protocol. Yjs is vendored as
one CommonJS file built from the mrmd editor's toolchain.

### Continued in design/52 (2026-09-20)
Guests (scope `guest`: nothing visible unless listed), project-scoped
invite links, stable project ids, sync between installs (mirrors, one
writer per record, redaction at export) and the two-level environment
document: [52-project-invites-and-sync.md](52-project-invites-and-sync.md).
