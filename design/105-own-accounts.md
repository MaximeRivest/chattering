# 105 · Each person runs as their own computer account

*2026-10-24. Builds on design/46 ("Team scale: the one architectural fact"),
53 (guest walls), 55 (caps), 72 (team). Modules: `accounts.js`,
`account-manager.js`, `account-setup.js` and `account-host.js` (run as the
person), `account-files.js`, `runtime-publish.js`, `install/chattering-as`;
changes in `server.js` (principal, sources, routes), `pisdk.js` (walls),
`policy.js` (ACCOUNT_ROUTES), `users.js` (account, models), `session-snapshot.js`
(forks), `files-browser-server.js` (io), `usageanalytics.js`, `people.js`,
`app.html`; `scripts/account-move.js`. System side (NixOS):
`~/Projects/os/machines/modules/chattering.nix` (`services.chattering.accounts`)
and `hosts/lambda/family.nix`. Tests: `accounts` (pure), `accounts-e2e` (a
real server, a real second account, through the real sudo rule),
`accounts-people-browser`.*

## What it is

Who a person is (users.js) and what their processes run as are now two
things. A person linked to a computer account of their own runs as it:
their agents, their commands, their forks, the files Chattering reads and
saves for them. Linux decides what they can reach, with the rules every
other program obeys. Nothing here is a policy an agent could talk its way
around, and nothing of theirs ever runs as the server's account because
their account was not ready: until it is, their launches are refused with
the reason.

Everyone not linked runs as before (the household, the owner). The setting
`accountsRequired` makes a link mandatory below the owner. Guests keep
their sandbox (design/53) unless linked.

## How a process changes account

One sudo rule, for one program, towards one group, never root:

    SERVICE ALL=(%chattering-people) NOPASSWD:SETENV: /nix/store/…/chattering-as
    Defaults!/nix/store/…/chattering-as closefrom_override

`chattering-as DIR -- FILE ARGS` (install/chattering-as, root-owned) sets
HOME, USER, LOGNAME and SHELL from the account database (never the
caller's), the PATH the server computed, removes every `SUDO_*`, enters DIR
as the person and execs. It refuses root and any account outside the
people group even when the caller's sudo would allow more (an administrator
is allowed everything by their own rule). `--probe` answers one JSON line
with protocol 1; the server refuses a mediator that speaks another.

`sudo -n -E -C 4 -u NAME -- chattering-as …`: `-n` fails at once without a
rule; `-E` carries the environment accounts.js built, deny by default
(locale, certificates, the person's own Chattering credential, never the
server's install token, Pi folder, keys or display); `-C 4` keeps descriptor
3, the Pi worker's IPC channel, so the worker runs exactly as for the owner.

Rejected, with the reason:
- *setuid helper or root daemon*: new privileged code to get wrong; sudo
  is audited, logged and already trusted.
- *systemd-run --uid*: needs the right to manage system units (root in
  all but name) and passes no descriptors.
- *one Chattering per person, paired* (islands, design/52): works today, but
  loses the one hub (presence, the owner's view, sharing) a household and a
  company want.

Every launch runs inside `chattering-person-<account>.slice` of the
server's user manager (systemd-run --scope). sudo stays in the scope (no
PAM session moves it, verified), so resource caps apply and `cgroup.kill`
stops all their processes. Signals from the server cannot reach another
account's processes; cgroup.kill can (verified with `nobody`). The stop
button uses it; a run stopped by timeout gets SIGTERM through sudo, then its
scope killed.

## The code they run

A home is private (0700), so another account cannot run code from the
server's checkout. `runtime-publish.js` publishes what a worker needs (this
program's modules, extensions, the pinned Pi, the owner's Claude Code
provider extension: code, never credentials) to
`/var/lib/chattering/runtime/app-<hash>` and `pi-<hash>`, readable by all,
writable by the service. Content-addressed and published once per server
process (the copy is the code this process runs), renamed into place at
the end, old copies pruned after two days. On btrfs and XFS a reflink: 463
MB in about a second, no space. Paths of the checkout in arguments, in the
worker's extension list and in the setup run are mapped to the copy.

The node must be readable by every account: the service's node from the
Nix store is. The probe checks it.

## Their conversations

`/var/lib/chattering/people/<account>/sessions`: owned by them, group root,
0750, ACL `u:<service>:r-X` and defaults so new files stay readable,
declared by the system configuration and re-applied at every boot
(tmpfiles `A+`). Outside their home on purpose: NixOS re-applies a home's
mode at every switch, which zeroes an ACL mask, and the server needs
nothing else of their home. Their `~/.pi/agent/sessions` links to it, so
Pi in their own terminal lists the same conversations.

The source `pi@<account>` (keys `pi@lilly:--home-lilly-…/….jsonl`) is
registered before the first scan; anything true of Pi conversations is
true of theirs (`isPiSource`).

The server's rights in that folder are read-only, and it reads only what
the folder's owner owns: `accounts.openOwned` opens without following a
final symlink and checks the open descriptor (a plain file, their uid), so
a symlink they plant to the server's own files is never read, and a
symlinked folder leads nowhere either (same check). The index, the parser,
the usage parser and the frog's reader go through it; the directory walk
and the watcher never enter a symlinked folder.

**A conversation runs as the account that keeps it.** No one drives
another account's file, the owner included (`assertRunsHere`): a 409 with
`fork: true`, and the page says so before anyone types ("This conversation
belongs to …: fork to continue"). The fork is the reader's own: written by
their host process into their folder (or the server's, for the server's
account), from a copy read with the owner check. Work nobody typed (a run
resumed after a restart) runs as the folder's owner.

The terminal bridge (`/api/conversation/send`, which types into a terminal
on the server's screen running as the server's account) is refused to
anyone behind walls. That also closes a gap guests had: their send could
make the owner's terminal run their text with the owner's rights.

## Their files, through Chattering

Checking "may Lilly read this?" and then reading it with the server's
rights is the confused deputy: between the two, a symlink of hers can aim
the read at the server's key. So the server never touches their files with
its own rights. `account-host.js` is a long-lived process as them (one per
person, started on first use, stopped after ten quiet minutes) that does
the disk work over IPC; the server relays bytes and keeps its records
(history, ledger, editing log) of the text it is handed.

`policy.js` adds a second decision per route: `ACCOUNT_ROUTES` lists what a
person on their own account may reach below the owner tier, as `index`
(works from the conversation index or the server's own records, never a
path they name) or `theirs` (acts through their walls or their host).
Everything else answers 403 for them with the reason, until it is made
theirs: fail closed, not "probably fine". Made theirs so far: runs, forks,
commands, the live terminal, reading, saving, viewing (images, PDF, video,
with ranges), path links in transcripts, the folder picker, the project's
file browser and search. The owner tier keeps the server's rights.

## Models

Per person: `own` (their account's Pi folder and their own logins) or
`shared` (the owner's subscriptions through the key proxy, design/53: a Pi
folder of Chattering's in their home, `~/.local/state/chattering/pi-agent`,
with placeholder keys the proxy swaps, their own settings, extensions,
skills and guidance linked in). Usage and budgets count per person either
way. When an AI account is added or removed, the proxy's list is read again
and people on shared models get a Pi folder that names it.

## Linking, and moving folders

Settings → people: "own computer account…" beside a person (administrators
only: which account runs someone's code is machine administration), the
state of each linked person (ready, the problems in sentences), "check
again", and the `accountsRequired` switch. Linking checks the account
exists, is a person's (uid ≥ 1000, not root, not the service account), is
in the people group, the sudo rule works end to end and the node runs; then
publishes, and runs `account-setup.js` as them (their sessions link, the
shared-models folder, git's user.name when empty).

`scripts/account-move.js FOLDER --to ACCOUNT` moves a folder of the
service account's to theirs: read-only plan by default (size, git state
and remotes, symlinks pointing out, processes working inside,
conversations that worked there), `--yes` renames it (same file system:
instant), chowns it and records the move (`/api/accounts/folder-move`):
forks of conversations that worked in the old place work in the new one,
registered projects follow their folder. Conversations are not moved: they
ran as the account that keeps them.

## Trade-offs, stated

- **The server's account is still the owner's** on lambda (maxime: an
  administrator with keys). Reads of member trees are as them, so the
  confused deputy is closed where they name paths; but the end state an
  expert would choose is a dedicated service account with nothing of its
  own, the owner running through the mediator like everyone. Second
  deployment mode of the same code (design/46); not done.
- **Not every feature is theirs yet.** Refused for people on their own
  account until ported, with the reason: file operations (create, rename,
  delete), notebooks, change reviews and file history drawers, artifacts and
  previews, shares and publications, git views, voice, AI programs,
  delegations' views, codex and Claude Code runs, the desktop terminal.
- **Their old conversations stay the server's account's.** They read them
  and fork to continue. Moving records between keys (notes, titles,
  filings, sharing rules) would touch fifteen stores for history that is
  honest as it is.
- **sudo logs every launch** (command line included) to the journal: an
  audit trail, and also what was typed into a command block.
- **The person's host runs while they use files** (ten minutes after the
  last call): one process of theirs per active person.
- **Briefings** reach their agents in the system prompt; the memory files
  they name are read through the records tools (their own token), not from
  disk.
- **Git in a member's repository is never run as the server** (git refuses
  a repository another account owns, and nothing here weakens that: a
  member's `.git/config` could otherwise run code as the server). Git views
  of their repositories are refused for now.
- **A shared project** (two people's work in one folder) is not a move: it
  needs a shared folder with a group, default ACLs, `core.sharedRepository`
  and `safe.directory` for exactly that path. Not built.
- **No caps by default** for people (guests have them): the slice is there,
  set properties on it to cap someone (`systemctl --user set-property
  chattering-person-<account>.slice MemoryMax=…`).
- **Linux only** (sudo, cgroups). Elsewhere the settings page says so and
  nobody can be linked.

## Setting it up

NixOS (`services.chattering.accounts`): `enable`, `serviceUser`, `group`
(default `chattering-people`), `people` (their conversation folders),
`testAccount` (`chattering-test`, for `accounts-e2e`). It declares the
group, the mediator, the sudo rule, `/var/lib/chattering/{runtime,people/*}`
and asserts that the people are in the group and the service is not.
Elsewhere: install `install/chattering-as` root-owned and mode 755, add the
two sudoers lines, create the group and the folders with the same modes and
ACLs (`setfacl -m u:SERVICE:r-X,d:u:SERVICE:r-X,d:u:PERSON:rwX …`).
