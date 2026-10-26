# 106 · Actors, and the hub that owns nobody's files

*2026-10-26. Follows design/105 ("Each person runs as their own computer
account") and design/46 ("Team scale: the one architectural fact").
Modules: `person-ops.js` (the operations), `account-host.js` (runs them as a
person), `server.js` (`localActor`, `actorOf`, `actorForPath`,
`viewerIo`, `REACHES`), `policy.js` (`ACCOUNT_ROUTES`). Tests:
`accounts-e2e` (both tests: a real second account, through the real sudo
rule), `accounts`, `queue-opened-mid-run`.*

## The problem, plainly

Chattering's server runs as one account (the owner's, on lambda) and did
everything for everyone with that account's rights: it opened files in
about 620 places and started programs (git, rat, Pi) in about 60 more,
with nothing in between deciding *as whom*. When people got accounts of
their own (design/105), a gate at the door refused every route not yet
converted to act as them. Lilly met the refusals one by one: artifacts,
pictures, documents, notebooks, git views, projects.

## What an expert builds, and what they reject

The design every serious multi-user system converges on is
**privilege separation with a hub**: JupyterHub (a hub, and a single-user
server per person, as that person), OpenSSH (an unprivileged monitor and a
child per user), Gitea and GitHub (git runs as the service that owns the
repositories; requesters are authorised by the app). Applied here:

1. **The hub owns nobody's files.** It keeps its own records (index,
   notes, settings, its caches) and never opens a person's file with its
   own rights.
2. **Work on someone's files and programs is done by a process running as
   them** (`account-host.js`, one per person; Pi workers and rat through
   their walls). Linux decides what it may touch, as for any program of
   theirs.
3. **Whole operations cross the boundary, not system calls**
   (`person-ops.js`): "run git", "list these folders", "keep this plot",
   "undo this setup". One table, the same code everywhere: the hub runs it
   in-process for its own account, a person's host runs it as them.
4. **One path for everyone.** A route asks for an *actor*, never "the
   owner's way" and "everyone else's way": `actorOf(identity)` for what a
   requester does, `actorForPath(p)` for work that belongs to the owner of
   a path.

Rejected, with the reason:

- *Check "may Lilly open this?", then open it with the server's rights.*
  The confused deputy: between the check and the open, a link of hers can
  aim the open at the server's own secrets. Proposed in this conversation
  as "one central check"; withdrawn.
- *A transparent file-system proxy (every `fs` call, in every module,
  silently routed to the person's host).* "A note on distributed
  computing" (Waldo et al., 1994): a remote call is not a local one; it is
  slower, it fails half-way, and synchronous calls (318 of them in
  server.js) cannot be remoted at all. It also hides the trust boundary in
  a monkey-patch nobody can audit.
- *A per-person copy of the whole server* (islands): loses the one hub
  (presence, sharing, the owner's view) a household and a company want
  (design/105 rejected it for the same reason).

## Whose rights, decided once

| Work | Done as | Why |
|---|---|---|
| Reading, saving, listing a person's files for a request | the requester (`actorOf`) | Linux answers per person; a requester gets nothing their account could not open |
| Git (history, docs, commits, line attribution) and git metadata | the repository's owner (`actorForPath`) | git reads the repository's config and runs its hooks: only its owner may run them; git itself refuses foreign repositories |
| Saved file history (versions, what a step changed) | the requester's own store | each person's agents keep theirs, in their home |
| Kernels, notebooks | the requester's own rat, through their walls | their environments, their kernels |
| Background upkeep (indexes, project folders) | the path's owner | no request, no requester |

Git run as the owner could show a requester a repository Linux keeps from
them. `REACHES` closes that: for someone on their own account, a
repository, project folder or file a route names must be one their own
account can read (asked as them, through their host), and the repository
list holds only those.

## Where things stand (2026-10-26)

Done as the person, each tested end to end as a real second account
(`accounts-e2e`):

- runs, forks, commands, the live terminal, reading and saving files,
  viewing media, the Files browser and its search (design/105);
- artifacts and the preview address, versions from their own history;
- a conversation's pictures, recorded edits, what its steps changed, the
  file now, the system prompt their agent saw;
- the composer's @ files and snippets;
- Markdown documents (save, create, commit with their own git identity,
  pictures beside them, line attribution), notes;
- Files: rename, copy, delete into their own "recently deleted", restore;
  HTML previews and their assets;
- git: repository list, history, commits, changes between commits,
  project history and documents, "touched", history scope;
- notebooks: run, cancel, input, doctor, kernels, variables, plots and
  displays, keeping outputs, following kernels, the conversation's
  notebooks;
- projects: the folder pickers, create, add, undo setup, areas, README;
- "ask about this file".

Still refused to people on their own account, with the reason (the gate
fails closed until each is made theirs):

- change reviews (`/api/reviews/*`): reviews read checkpoints and files
  across conversations; needs the review service per actor, like
  `stepChanges(identity)`;
- shares and publications: a share link serves a file to anyone, read
  at serving time; must be read as the person who shared it
  (`actorForPath` of the file, authorised by the share);
- delegations' views and control, `agents/kill`: their workers' records
  live in the hub's delegation root; their processes need the person's
  slice (`cgroup.kill`), not signals;
- handoff to Claude Code or Codex, Codex menus and release: Codex runs as
  the hub today (design/87); needs Codex launched through the person's
  walls with their own Codex login;
- AI commands in the editor (`/api/doc/ai*`) and "notebook from an
  answer": the model call runs as the hub's Pi; needs the person's Pi
  (their models, their usage), as `startAgentRun` already does;
- vouching (`/api/vouch*`), file feedback, AI programs (`/api/programs*`),
  the frog's hotkey, machine probes.
- the terminal bridge (`/api/conversation/send`, `act`): types into a
  terminal on the hub's screen. Stays refused: a person's terminal is
  their own (the live terminal does this, as them).

Known remaining reads with the hub's rights, outside routes: the project
file watchers and the file ledger's backfill (`updateWatchedProjectFile`,
`ledgerIngestRepo`) read changed files of watched project folders; the
search index reads transcripts through `accounts.openOwned` (safe: a file
the person owns, never a link). On lambda the hub can read shared project
folders through their ACLs, so these work today; under the unprivileged
hub they must move to the owner's host (a watch operation that pushes
events back).

## The end state: an unprivileged hub

The same code, a second deployment mode (design/46): the hub runs as a
system account `chattering` with nothing of its own but
`/var/lib/chattering` (its data, config, cache, notes, mirrors), and
**every** person, the owner included, works through `chattering-as`.
Then a route that forgets to ask for an actor fails with "permission
denied" instead of reading someone's file: the operating system enforces
what today is enforced by review and the gate. `ACCOUNT_ROUTES` then
disappears; the owner tier keeps administration, not file rights.

What the cutover needs, in order (none of it done yet):

1. The remaining routes above, made actor-aware.
2. Background work by path owner (watchers, ledger, folder index) through
   host operations.
3. The owner's conversation sources read like a person's: Pi sessions
   move to `/var/lib/chattering/people/maxime/sessions` (his
   `~/.pi/agent/sessions` links there, as Lilly's does); Claude Code,
   Codex, Muse and Antigravity transcripts read through his host (they
   stay where those programs write them).
4. The hub's own data moves from `~/.local/share/chattering`,
   `~/.config/chattering`, `~/.cache/chattering` and `~/notes/chattering`
   to `/var/lib/chattering/{data,config,cache,notes}`; agents read notes
   through the records tools (they already may), the owner's
   `~/notes/chattering` becomes a link for his own tools.
5. The key proxy's keys: today it reads the owner's Pi `auth.json`. Under
   the hub it needs its own copy kept fresh by a refresh operation run as
   the owner (sign-ins rotate: never two holders of one refresh token).
6. Desktop actions on the owner's screen (opening a terminal window,
   sounds, the clipboard): through his walls with his session's
   `WAYLAND_DISPLAY`/`XDG_RUNTIME_DIR`, allowed by `chattering-as` only
   for the person whose session it is.
7. NixOS: `users.users.chattering` (system), the service unit as it, the
   sudo rule from `chattering` to `%chattering-people` (maxime joins the
   group), tmpfiles for the new folders.
8. A staging instance as `chattering` on another port, the whole e2e
   suite against it, then the cutover with a written rollback (the old
   unit and data stay until the new one has run a week).

Each step keeps the household mode working; the last switch is one
deployment setting, reversible.
