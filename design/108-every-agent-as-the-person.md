# 108 · Every agent, as the person

*2026-10-30. Follows design/105 (each person runs as their own computer
account) and design/106 (actors). Modules: `accounts.js` (`AGENT_FOLDERS`,
`agentRootFor`, `agentPathInRoot`, walls' `agentRoot`, `programs`,
`tokenFile`, `hostCwd`), `account-setup.js` (the links, the token file, the
programs found, Antigravity's hook), `account-manager.js` (`agentProblem`),
`person-ops.js` (`agent.transcript`, `agent.image`, `conversation.create`),
`harness/codex.js` (`launch`, one helper per account),
`harness/live-terminal.js` (`root`, `hostCwd`), `harness/terminal/hub.js`
(`watchOnly`), `server.js` (`harnessOfSource`, `agentSourceRoot`,
`agentProgramFor`, `assertAgentReady`, `codexTarget`, `liveWatchOnly`,
`handoffConversation`), `scripts/account-agent-folders.js`. Test:
`accounts-e2e` (the third test: a real second account, its own Claude
Code and Codex).*

## The problem, plainly

After design/105 a person on their own account ran Pi as themselves, and
nothing else did. Claude Code, Codex, Antigravity and Muse Code were
started with this server's programs and folders:

- Claude Code: the server found *its own* `claude` (in the owner's home),
  asked the system to run that file as Lilly, and Linux refused (the
  owner's folders are closed to her): "Claude Code ended", every time.
- Behind that, two more: the new conversation was looked for in the
  owner's Claude folder, and Claude Code's tools were given the owner's
  token file, which she cannot read (and must not).
- Codex in Chattering's box was refused outright ("this machine's own
  account only"); in its own program it had the first problem.
- Pi in its own program was not offered for her conversations at all (the
  page looked for a program named `pi@lilly`), and a new one was looked
  for in the owner's Pi folder.

## What an expert does

Exactly what design/105 did for Pi, for every agent, through the same
walls: **the person's own program, their own sign-in, their own folders,
and this server reads only what it was declared to read.**

1. **Their program.** The program is named, not found: `claude`, `codex`,
   `agy`, `muse`, and `chattering-as` (the mediator) runs it with their
   PATH, as them. The account's setup (run as them) says which they have,
   so only those are offered (`agentsInstalledFor`).
2. **Their conversations, where this server may read.** Each program writes
   in a folder of the home (`~/.claude/projects`, `~/.codex/sessions`,
   `~/.gemini/antigravity-cli/conversations`, `~/.local/share/muse/sessions`),
   which the server must not read. Setup makes each a link to a folder
   beside their Pi one, `/var/lib/chattering/people/<account>/<agent>`,
   theirs to write and readable here (the people folder's declared ACL,
   inherited: no change to the system configuration). Each is a source,
   `claude@lilly`, `codex@lilly`, …: the agent before the `@`, whose folder
   after (`harnessOfSource`, `accountOfSource`; `pi@lilly` as before).
3. **Read safely.** Pi and Claude Code files are read with `openOwned` (no
   final symlink, a plain file of theirs), as in design/105. Codex,
   Antigravity and Muse Code files are read in their formats by the
   person's host (`agent.transcript`, `agent.image`): an Antigravity
   database closed by its program can only be opened by its owner (verified:
   "attempt to write a readonly database" from another account), and a
   reader that follows the file's own references (a Codex fork's parent)
   reaches only what they may.
4. **The grant, kept.** The people folder's ACL lets this server read, but
   a program that makes its files 0600 and folders 0700 explicitly (Claude
   Code does; Lilly's Codex files are 0600) leaves the ACL's mask empty, and
   Linux refuses the read (verified). A refused read, stat, listing or
   watch of a person's folder asks their host to put the declared grant
   back, as them, on that path and the folders above it inside their
   people folder (`people.keepReadable`, `setfacl -P`, never a link), then
   tries once more (`asDeclared`); a new conversation's folder is kept
   readable while its program starts it; setup does a whole folder once.
   Nothing outside their people folder becomes readable.
5. **Their tools' credentials.** Claude Code's Chattering tools run the
   published copy (readable by every account), and are given their token's
   *file* (`~/.local/state/chattering/token`, written by setup, 0600), never
   the install token and never a token on a command line (sudo logs it,
   `ps` shows it).
6. **Codex in Chattering's box** runs `codex app-server` behind their walls
   (`codexTarget`: their program, their environment, `launch`), one helper
   process per account for menus, its models cached per account, and the
   paths it reports (in their home, through the link) translated to where
   this server reads them (`agentPathInRoot`).

### One writer, one account

**A conversation runs as the account that keeps it**, for every agent now
(`assertRunsHere`): her Claude Code cannot even open the owner's
conversation, and the owner must not type into hers. Pi and Claude Code
conversations fork into the reader's own folder, as them (Claude Code's
fork used to be written beside the original, by this server). Codex,
Antigravity and Muse Code conversations cannot be copied as they are
(their program owns their files), so another account *continues a copy*
with an agent of theirs: a handoff whose new conversation carries the
history and is **not** linked as the original's continuation (a link would
lock the owner out of his own conversation). The page says which.

A program already running is attached by every page that may see it; a
page of another account may **watch** it, not type into it
(`liveWatchOnly`, the hub's `watchOnly`).

### A folder of an agent's own

A home folder that already holds conversations is not linked by setup:
moving someone's records is done on purpose, never as a side effect
(design/105's rule for Pi). Until moved, that agent is not started for
them, with the reason (`agentProblem`), and its conversations are not
listed. `scripts/account-agent-folders.js ACCOUNT [--yes]` moves them as the
person (refusing while that agent runs for them), puts the link in place
and asks Chattering to set them up again.

## Everything else, as the person (2026-10-30, second part)

After the agents, every route still refused to people on their own account
was made theirs, the same way: the work is done by their own process (their
host) or their own Pi, and Linux decides.

- **One-off model calls** (the editor's AI commands, a notebook from an
  answer, review suggestions, AI programs, their endpoints and hotkeys): made
  by their own Pi through their walls (`piExec` with `ctx.principal`;
  `callPrincipalFor`, `ownPrincipalOfPerson`), with their last pick or their
  Pi default, never this server's settings model, on a circuit of their own.
  The system prompt goes in a file their process writes in their home (a
  command line is visible to everyone and sudo logs it), removed after.
- **Change reviews** live beside their saved file history, in their own
  store: the review service runs in their host (`OPS.reviews`, the methods
  in `change-reviews.js` `REMOTE_METHODS`), so do "what a conversation
  made" (`OPS.made`) and a reviewed file opened in the editor
  (`reviewFileAs`). Which store holds a review id is the hub's record
  (`review-accounts.json`). A person reviews what their account ran; the
  owner tier any; everyone only what they may see (`assertReviewAccess`).
  A review's message is sent as the person sending it.
- **Shared links and shared editing**: a shared document is resolved as the
  person who shared it (their `io`: read, assets, a two-second look for
  changes instead of a watch); a shared file's live copy is joined as the
  person (their process reads it and says whether they may write), and each
  save is done with the rights of whoever typed last (a link's visitor: the
  person who shared it) (`collabWriterOf`). Publications copy the
  artifact from their disk and their history, as them.
- **Delegated work**: their Pi records its workers in its own folder in their
  home, and the workers run as them. Every view and control asks their
  process (`delegationRecords(account)`); each account has a coordinator of
  its own that delivers their workers' results to their conversations
  (`delegationCoordinatorOf`; its bookkeeping is the hub's, per account).
  Stopping a process from the agents view goes through their process: Linux
  refuses anyone else's.
- **Vouching** reads the file as them; a vouch is taken back only by whoever
  made it (or the owner tier). **Ink feedback** is kept in their home and
  sent to their conversation as a message with the picture (no terminal
  window opens on this computer's screen).
- **AI programs**: the call log shows a person only the calls made for them
  (a per-person view of the index: `programs.js scoped`); the programs they
  make are kept in Chattering's own folder (never written into their home
  by this server) and answer with their models.
- **Plug-ins (MCP servers)** in Chattering's own box, for everyone: Pi's
  built-in MCP, codemode and tool-search extensions are loaded as Pi's own
  program loads them (a person's settings may turn them off). A folder's own
  servers (`.pi/mcp.json`) load once the folder is trusted: `/trust` in
  the box saves Pi's own decision in the runner's Pi folder, as them. A
  sign-in (`/mcp login <server>`) shows its link as a notice (tappable, kept
  whole) and asks for the address the browser was sent to; no browser opens
  on this computer.

Still refused, on purpose: what acts on the desktop of the computer the
server runs on (typing into a terminal window there, opening a file there).
They say so (`ACCOUNT_DESKTOP` in policy.js).

## Trade-offs, stated

- **A link in their home.** The program writes through a link to a folder
  outside their home; the operating system follows it for any program that
  opens paths normally (tested with stand-ins written like each program,
  not yet with each real program). A program that refused links would keep
  writing into its own folder and Chattering would not list its new
  conversations: nothing lost, and the person's own folder says so.
- **The owner's settings → agents options** (extra arguments per program)
  apply to everyone's runs: they are this installation's.
- **The owner's other Claude subscriptions** (`claude-accounts.js`) are the
  owner's: a person runs their own login only.
- **Whether `--system-prompt-snapshot` is understood** is asked of this
  server's Claude Code, not the person's (a version apart at most).
- **Codex's own fork** works on the account that keeps the conversation
  only; another account continues a copy (Codex refers to the original's
  records, which another account cannot read).
- **Untested end to end on a real account:** Pi, Antigravity and Muse Code
  in their own program as the person (the paths are the ones tested for
  Claude Code and Codex; the programs themselves are not stand-ins here);
  a notebook from an answer, AI programs made and tried, and a plug-in as
  the person (the same code as for the owner, tested there).
- **The grant is put back after the fact.** Between a program making a
  private file and the first refused read, this server cannot read it; the
  retry happens on that read (a few milliseconds through their host). The
  end state (design/106: every read through their host) needs no grant.
- **A person's programs are kept by Chattering**, not in their project
  folder: their agents and git do not see them there.
- **Reviews of another account's work** are refused to a person on their
  own account (the history is that account's); the owner tier opens any.
- **A person's delegated work is asked of their process every ten seconds**
  while they are set up: their process keeps running.
- **A document shared by someone on their own account** is looked at every
  two seconds for outside changes while visitors are connected, instead of
  being watched.
- **A plug-in sign-in** needs the address pasted back (the browser cannot
  reach the computer's own callback); the link is long and shown whole.
- **Still the end state of design/106**: the hub runs as the owner's account
  on lambda; reads of a person's agent folders rely on the declared ACL and
  the owner checks above, not yet on the hub having no rights of its own.
