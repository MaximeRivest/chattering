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
  Claude Code and Codex; the programs themselves are not stand-ins here).
- **The grant is put back after the fact.** Between a program making a
  private file and the first refused read, this server cannot read it; the
  retry happens on that read (a few milliseconds through their host). The
  end state (design/106: every read through their host) needs no grant.
- **Still the end state of design/106**: the hub runs as the owner's account
  on lambda; reads of a person's agent folders rely on the declared ACL and
  the owner checks above, not yet on the hub having no rights of its own.
