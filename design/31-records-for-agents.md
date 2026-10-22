# Records for agents

## Problem

A conversation started from a project gets a snapshot: the four memory documents, maybe an epic or a few notes. After that the agent is blind. Hundreds of conversations, notes, evidence cards and a search index exist on the machine, and nothing tells the agent so, or how to reach them. The agent then asks the user what was decided, or invents it.

## Model

One read-only view of the records, rendered as plain text for a context window. `records.js` owns it. Three doors open onto the same text:

- The `chattering` command (any agent with a shell, any folder, any project; also people).
- `GET /api/records/<op>` (curl, scripts, other tools).
- Five Pi tools in `extensions/records.ts`: `chattering_search`, `chattering_show`, `chattering_memory`, `chattering_read`, `chattering_list`.

The text is one format everywhere, so a bash user and a tool user read the same thing and the three doors cannot drift.

Ops: `search`, `show`, `conversations`, `projects`, `memory`, `notes`, `note`, `epics`, `epic`, `evidence`, `here`, `help`.

## Rules of the renderer

- Bounded. Every answer stops at `max` characters on a line boundary and says how much is left and how to page.
- Actionable. An answer never ends in a dead end. Each hit carries the follow-up command (`chattering show <id> --at N`); each list ends with the next command.
- Honest. Records are AI transcripts and AI-written notes. Every note, memory document and epic prints its trust label next to its path. A stale note (the conversation continued after distillation) says `STALE`. A conversation with a live agent says `LIVE`.
- Short ids. A conversation key is a long path. The renderer prints the first 8 hex characters of the session uuid, lengthened in steps of 4 only where another conversation on record shares them (Pi's uuids are v7: the first 8 characters are a coarse timestamp, the same for every conversation started within ~65 s, so two started in a burst would otherwise print as one). `conversation-ids.js` owns this, for the records tools, the CLI and the frog alike. The resolver accepts a short id or any longer prefix of the uuid (dashes or not), a full key, a session file path, or any unique substring; when several match, it lists them with the ids that work now and never picks one.
- Local time for dates and times, both, so a day never disagrees with the clock next to it.

## Search

Lexical first (the FTS5 index, same grammar as the UI: bare words AND, quoted phrases, `project:` `role:` `type:` `after:` `before:` `path:`). When the semantic stage is reachable, its groups ride after the lexical page, marked `~semantic`, without duplicates. The index has no stemming; like the UI, the last word prefix-matches. `--no-prefix` asks for whole words. Filters map to the same operators (`--project`, `--role`, `--type`, `--since 30d|2w|2026-08-01`).

The Pi tools pass the running conversation's own session file as `excludePath`; its hits are dropped so an agent never "finds" what it just said. The CLI has no such knowledge; a self-hit shows as `LIVE`.

## Show

Three shapes, chosen by the arguments:

- No position: header plus an outline of every user turn and the last assistant message. The agent picks a `#N`.
- `at` (with `context`, default 3): the messages around `#N`, all roles, so tool calls and results are visible where it matters.
- `from`/`to` or `last`: a slice or the tail, user and assistant only unless `roles=all`.

Per-message clips keep what people and the model said nearly whole (4000 chars) and cut tool noise hard (500/900) and thinking harder (600).

## Where agents learn about it

- The inline context bundle and the file briefing carry one fixed section, "Looking things up (Chattering records)": the three commands that matter and the trust rule.
- The Pi tool descriptions and prompt guidelines repeat the rule.
- The user's global `AGENTS.md` names the command for sessions that start outside Chattering (terminal Pi, Claude Code).

## Limits and trade-offs

- Claude Code sessions read the records through bash, not through structured tools. Best effort, by design.
- Search recall is bounded by the index: no stemming, exact words AND. Semantic search fills the gap only when the GPU stage is up.
- The renderer reads the same caches as the UI; it does not re-parse transcripts. A conversation the watcher has not indexed yet is not visible.
- Access is read-only and local. Note files are restricted to the notes tree. LAN callers need the usual token.
- Delegated workers with an explicit `tools` list see the records tools only when the parent lists them.
