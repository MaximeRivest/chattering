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

Per agent, written down and tested (`live-terminal-server`, `live-terminal-guest`):

| | Claude Code | Codex | Pi |
|---|---|---|---|
| the owner | yes | yes | yes |
| a household member (household isolation) | yes | yes | yes |
| a member walled per person | no | no | yes, inside their walls |
| a guest (invited to a project) | no | no | yes, inside their walls |

The household rule follows what members already do (design/46: they run
agents as the account). F19 noted that household members were allowed
where an assurance said otherwise; here the rule is stated and tested for
each kind of person, on every route and on the socket; settings and the
options programs start with are the owner's alone.

**Walled people use Pi in its own program inside their walls** (design/53):
the program is started inside their bubblewrap and slice, sees the shared
project and nothing else of the computer, has their own Pi folder with
the owner's extensions and skills read-only, and reaches the owner's keys
only through the key proxy. Its conversation lands in the project's own
session folder. "Stop their work" ends it. This is the owner's setup used
within what was shared.

**Not Claude Code or Codex for walled people.** Both sign in as the account
(a Claude plan, a ChatGPT plan); their credentials would have to stay
outside the walls behind the key proxy. Claude Code takes a base URL and a
token, so it likely fits the proxy (untested); Codex's ChatGPT sign-in
shapes its requests itself and does not. And a personal plan used by other
people may not be what its terms allow. They are refused with that reason.

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

## What the real agents taught (2026-10-01, Claude Code 2.1.287, Codex 0.153.4, Pi 0.87.1)

Run with the real programs in a browser on a laptop, an e-ink tablet and a
phone through the encrypted relay (`prototypes/terminal-document/done-check.js`).
Every finding is now a rule in the reader or the actions, with a test:

- **A click on Codex's first permission option chose the second.** Its
  options wrap their descriptions; the reader now walks over them, splits
  name and description, and takes the question from above the options (up
  to a frame line or two blank lines). Recorded and replayed.
- **The box is the proof a message was sent**, not a "working" line or a
  question: Codex shows "Starting MCP servers… esc to interrupt" while
  ignoring the Enter, with the message still in its box. Enter is pressed
  again only while the box still holds exactly the message.
- **A program that just started is still drawing**: Codex shows its box,
  then asks to trust the folder. A message waits for the screen to settle,
  for the box, and is never typed into a question; if a question took its
  Enter, it goes once the question is answered.
- **Claude Code writes its answer with no working line**; its window title
  turns ("◐") while it works and shows "✳" when idle. That title is in its
  profile. Codex turns a spinner in its title even when idle: not in its.
- **The page redraws the conversation whenever the agent writes its file**,
  replacing the strip: the focus and caret come back in the same moment
  (typed letters had reached the page's shortcuts; a phone's keyboard
  would have closed).
- **Codex wraps a long line inside a path** ("…test/" / "outside/…") and
  after hyphens; Pi lists its commands without "/" and marks a selection
  below the first row; one suggestion left is a list of one.
- **Nothing is changed in an agent's own settings by Chattering.** Codex
  saves a choice made in its `/permissions` screen to its global config
  (this was found by changing it, and put back); options for one run go
  on the command line (settings → agents → start them with options).

## Verified with the real agents (2026-10-02)

`prototypes/terminal-document/done-check.js`, Chromium, the test copy,
Claude Code 2.1.287, Pi 0.87.1, Codex 0.153.4, each agent's own sign-in:

| | laptop | e-ink tablet | phone, through the encrypted relay |
|---|---|---|---|
| new conversation | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| type with its own editor | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| pick from its `/` list | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| open and close a panel | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| answer a permission question | ✓ – ✓ | ✓ – ✓ | ✓ – ✓ |
| stop a running reply (shown stopped after) | 122 / 61 / 61 ms | ✓ ✓ ✓ | ✓ ✓ ✓ |
| back to Chattering's box | – ✓ ✓ | – ✓ ✓ | – ✓ ✓ |
| continue an existing one | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| every message shown once | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |

(Claude Code / Pi / Codex; "–": Pi has no permission questions; Claude
Code has no box of Chattering's own.) A 10-minute session on the phone
through the relay, all three agents in turn: 10 messages, 10 replies, no
state that came and went. Pairing to the app: 4.1 s. In an earlier run,
three devices at once hit the Claude plan's rate limit (429) through Pi;
Pi said so in the conversation. `test/live-terminal-real.test.js`
(CHATTERING_REAL_AGENTS=1) sends each agent one message; Claude Code was
ready in 1.1 s and answered in 0.8 s, Pi 0.5 s / 1.3 s, Codex 0.1 s / 2.8 s.

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
- **"Ready" is shown 0.7 s late** after the program's own work ends (at
  once after Stop): between two steps of its work (a tool, a retry, its
  hooks) a program is idle for up to half a second, and showing that made
  Stop and "working" blink. What is typed is never held.
- **An input method's composition is lost** if the agent writes its file
  during it (the conversation view is rebuilt). Updates from the program
  never disturb it.
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
