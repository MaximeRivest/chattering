# Whole-conversation review

A conversation that delegates is pull-request-shaped work without the pull
request (design/78, gap 2). **± changes** in the conversation's header (and
**Review all changes** in the phone menu) opens every change the
conversation and, recursively, its sub-agents made, in the review screen
steps and turns already use (design/36, 38): comments, suggestions, reviewed
marks, sending the review to an agent.

## Three views

The scope selector holds:

- **Agent edits** — files the agents' own write/edit steps (and recognised
  shell writes) targeted, one entry per file. A file several agents edited
  compares the version before the first agent's edit with the version after
  the last one's. An agent with no saved "before" never lends a later
  version as the starting point: the file is marked incomplete instead.
- **Other / unassigned** — workspace changes during an agent's steps that no
  step targeted, per agent, as before. Not proof of authorship.
- **Commits** — branches the agents committed to, each compared from just
  before the agents' first commit to their last, like a pull request.

An **agent** selector filters any view to one agent (its step list, its own
review, its conversation). With all agents together the thousands of steps
are not sent to the screen; choose an agent to pick one step.

## Who belongs

The conversation, then every delegation whose parent is it or one of its
delegations (design/29's recorded ancestry, never timing or folders). A
resumed worker is the same conversation. A delegation with no indexed
session is named in the resolution notes.

## Commits: evidence, not dates

`branch-work.js`. A commit is an agent's when it is on the checked-out
branch of a folder the agent's committing git command ran in (the agent's
working folder, a `cd`, or `git -C`; heredoc bodies are data), and its
committer time falls inside that command's run, ±2 s. Commits in the range
that no agent made are counted and named on screen and in the message sent
to an agent. Ranges that continue one another (a repair branch started at
the last one's tip) join into one section; where several branches start from
the same commit (four implementations of one contract) each stays separate.
Repositories in a temporary folder are scratch (test fixtures) and are left
out, with a note. Git is only read: `rev-parse`, `log`, `rev-list`,
`diff-tree --no-ext-diff --no-textconv`, `cat-file`, with hooks and
fsmonitor off. Renames show as a deletion and an addition.

## Sub-agents are recorded now

Delegated workers load `extensions/checkpoints.ts`, the same awaited
before/after hooks web sessions get, so their edits have saved versions like
the parent's. This starts with workers launched after 2026-09-29. Older
workers' edits usually have no before/after pair; when the edited file was
later committed, its card links to the **committed version**, which is
complete.

## Cost

Each agent gets its ordinary task review, built at most four at a time. A
finished agent's review is reused while its session file and its saved
checkpoints are unchanged (`conversation_review_agents`), so only a live
agent and the commits are read again. **View → Rebuild with the latest
changes** makes a new review; the old one and its comments stay.

The saved review keeps everything (a 77-agent conversation: ~4 MB). The
screen receives one agent's part, or all agents' files without steps and
shell references (`conversationReviewView`).

## Limits

- Authorship inside one file is not split: a file two agents edited is one
  diff, labelled with both.
- Commits made by a script the agent ran (not a git command in its own
  shell step) are not found.
- Claude Code's own sub-agents (its Task tool) are not delegations and are
  not included.
