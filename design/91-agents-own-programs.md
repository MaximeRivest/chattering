# 91 — Agents in their own programs: Claude Code, Pi and Codex live in the conversation

*2026-10-01. Builds on the prototype in `prototypes/terminal-document/`
(its README has the measurements and every bug found on the way) and on
design/87 (any harness). Modules: `harness/terminal/` (`host`, `reader`,
`actions`, `hub`, `profiles`, `recorder`, `pty-holder`, `deps`),
`harness/live-terminal.js`, `live-terminal-ui.js`, `live-terminal.css`;
hooks in `server.js`, `app.html`, `conversation-draft.js`, `policy.js`,
`settings.js`. Tests: `terminal-reader`, `terminal-replay`,
`terminal-agents`, `terminal-holder`, `live-terminal-server`,
`live-terminal-app`.*

## What it is

A Claude Code, Pi or Codex conversation can continue through that agent's
**real interactive program**, running on this computer, from any device:

- **The conversation** is Chattering's own view of the agent's session
  file: messages, steps, file changes, reviews, search. Nothing of the
  history is read from the screen.
- **The live part** comes from the program's terminal and is drawn in
  Chattering's style under the conversation: its input box (typing goes into
  its own editor), its `/` and `@` suggestions, its questions as buttons, its
  panels with a row of keys, "working…" with Stop, and while it works a
  window of what its tools print.

Why not only Chattering's own box: the program is the only place some
things exist (Claude Code's `/` commands, its permission questions, its
panels, plugins), and it is the agent as its maker ships and supports it,
signed in as its maker intends.

## How it works

```
devices (laptop, phone, e-ink; locally or through the encrypted link)
   ↕  WebSocket /api/live-terminal/ws — patches out; keys, text, clicks in
hub (hub.js): one program, every device; one typist; each message applied once
   ↕
host (host.js): headless terminal engine (xterm.js, VS Code's) = the exact screen
reader (reader.js): screen → live parts, with the agent's profile (profiles.js)
actions (actions.js): a click = keys, each step checked on the screen
   ↕  local socket, token
terminal holder (pty-holder.js): its own process; the pseudoterminal; recording
   ↕
claude --resume ID · pi --session FILE · codex resume ID   (unmodified)
```

**Profiles are data** (`profiles.js`): how to resume or start each agent,
the marks it draws, the key that stops it, the patterns that say "working".
The reader's rules are generic; a profile adds only differences. A new
agent, or a changed screen after an update, is an entry there, not a branch
in the code.

**Every click is a closed loop.** Choosing "Yes": move the highlight, wait
for a still screen, check the highlight is on "Yes", press Enter, check the
question is gone; if it was redrawn, look again. Never a blind key sequence
(a blind "down, Enter" once closed Claude Code).

**One writer per conversation.** Before the program starts, Chattering's
own Pi session lets go and its Codex connection releases the thread; a
conversation open in a terminal elsewhere, being answered here, or owned by
delegated work is refused with the reason. While the program runs, every
other way of writing the file here (web runs, compaction, branch edits)
refuses (`liveHeld`, checked in the same breath as a run would start).
Going back to Chattering's box ends the program first. A conversation that
is *also* opened in a terminal while its program runs here gets a warning
in its strip.

## Lifecycle

- **Survives a restart of Chattering.** Programs live in the terminal
  holder, a small process of its own (in a systemd user scope where there is
  one: a service restart stops everything in the service's group). On
  start, Chattering attaches again; the holder's own terminal engine
  serializes the screen (text, colours, cursor, input modes) and the strip
  comes back exactly, with whatever was half typed. The holder answers the
  program's terminal queries while Chattering is away. This is how VS Code
  keeps terminals across reloads. The holder ends once it holds nothing; if
  no Chattering has connected for 30 minutes, it ends its programs.
- **Idle programs end.** Nothing typed, not working, box empty, no question
  open, for the set time (30 minutes; a question or a half-written message
  waits four times longer). The next message starts it again from the
  file; text left in its box is put back.
- **The list's "working" mark** comes from the program's own state, not
  from "a process is running": idle is not working.
- **New conversations** of all three, from the draft screen: Claude Code
  and Pi are given the id first (`--session-id`; Pi names its file after it
  once the first message is written); Codex picks its own, and the new file
  is the one in that folder that appeared after the start (the one the
  program holds open, when there are two). The program runs under a
  temporary key until its file exists, then takes the conversation's.

## Who may (and the audit's F19)

The program runs as this computer's account with its sign-in to the agent.
So: **the owner and the household's members** — who already run agents
as the account under household isolation (design/46) — and **not walled
people**: guests (design/53) and members when isolation is per person. They
are refused on every route and on the socket, are not offered it, and do not
receive its events. Tested for each (`live-terminal-server`: owner, member,
walled member, guest). F19 noted that household members were allowed where
an assurance said otherwise; here the rule is written down and tested
rather than implied.

**Not done: guests inside their walls.** The aim is that someone invited
can use the owner's agents within what was shared. Pi already runs behind
walls with the owner's extensions and a key proxy. For these programs it
needs: the program started inside the guest's bubblewrap (the holder spawns
whatever command it is given, so the wrapping is the server's), and the
agent's own sign-in replaced by a placeholder the key proxy swaps. Claude
Code takes `ANTHROPIC_BASE_URL` and a token, so it likely fits the proxy;
Codex's ChatGPT sign-in shapes requests its own way and may not. Using a
personal plan for other people may also not be what an agent's terms allow:
the invite dialog must say so.

## Recordings

Each session's terminal side (every byte shown, every key received,
resizes; asciicast v2) and devices' side (who connected, what they sent,
what they were answered and shown) are kept like the conversation's own
file: in `<data>/live-terminal/recordings/<day>/`, gzip, 0600 in a 0700
folder, flushed every second (the session that ends badly is the one worth
replaying), 64 MB of terminal data at most each. A setting turns them off.
`node scripts/terminal-replay.js [--list | FILE --at HH:MM:SS]` replays any
moment: the screen, what the reader made of it, what devices did. A glitch
found this way becomes a recording in `test/fixtures/terminal/` and a test.

They hold whatever passed through the program, including anything typed
into it — the same as the agents' own session files.

## Pacing and size

A device receives only what changed (patches; lists from the first changed
entry), e-ink one update a second and no moving parts (following the theme
while the page is open), a spinner tick at most four times a second. In
this mode the reader reads the **visible screen only**, so an update costs
the same in the tenth hour as in the first (the scrollback kept is 200
rows). An update is bounded by the screen; over every recorded session the
largest was well under 64 KB; anything over 512 KB is recorded as a fault
and the device is shown the program's screen as drawn instead. No
compression is added on the socket: the updates are small, and the
encrypted link already carries them as they are.

## Accessibility

The focused field is a real text box holding the program's text and caret,
so screen readers read what is in the box; it is edited only by the program.
A polite live region says what changed — "asks: … Options: Yes, No",
"shows a panel… Escape closes it", "is working", "is ready" — never a
spinner's tick. The suggestion list is a listbox the field controls
(`aria-activedescendant`). Questions are groups of buttons; the key row is a
toolbar with named keys. Tab leaves an empty box. Input methods
(composition) finish before their text is sent. Touch targets are 44 px,
52 on e-ink, where the selected option is drawn (outline, bold), not tinted.

## Trade-offs, stated

- **Replies appear when each message is written to the file.** Word by
  word only for an agent that prints its reply so (Pi does; Claude Code and
  Codex print a reply when it is done: no terminal reader can stream what
  was never drawn). While it works, the strip shows what its tools print.
- **Each agent update can change its screen.** Generic rules, a small
  profile, recorded sessions replayed in tests; anything not understood is
  shown as drawn, with keys. The recordings and replay tests are the guard:
  re-run them on every agent update.
- **Full-screen programs** (OpenCode, Antigravity) get only the faithful
  panel with keys. Their own server or protocol is the better route later.
- **A second process** (the holder, ~40 MB) while programs run, so that a
  restart does not cut a reply. Without systemd (macOS, Windows, Linux
  without a user manager) it is a detached process: it survives Chattering
  restarting itself, not a service manager that kills the whole group.
- **Codex's new conversation is found by "the new file in this folder".**
  Two new Codex conversations started in one folder at the same moment,
  neither held open by its program, wait rather than guess.
- **Chattering's own features that write a conversation** (the file Ask
  box, reviews sent to it, compaction) refuse while its program has it,
  with the reason; they do not yet type into the program instead.
- **Windows** is built (the terminal part ships compiled for it, ConPTY)
  but not tested here; the holder's named pipe is guarded by the same token
  file as the Unix socket.
- **Terms.** It runs the real program under its own sign-in, as an editor's
  terminal does. Whether a vendor's terms allow remote use of a local CLI,
  or its use on behalf of others, is for each vendor's terms, not settled
  by this design.
