# 93 — Hotkeys: your AI programs, anywhere on your computer

Status: built 2026-10-03 for Hyprland (Linux). The frog (selected text, no key to remember) builds on it: design/94. macOS, Windows, GNOME, KDE
and X11 are named by the helper and not built. Follows design/75 (making
programs and giving them an address).

## The job

*When I am writing anywhere (an email, a chat, a form, a document in
another app), let me select text, press a key, and have one of my AI
programs fix it, translate it or explain it, without copying it into a
chat and back.*

What people use today: Grammarly (one fixed job, a hosted service that
reads everything), a "rewrite" button inside one app, a hand-made script
bound to a key (the first version of this was one, `aikey`, made the same
day and retired for this: it worked for one person on one machine, and its
prompts lived in a file nobody could judge). Chattering already has the
part that matters most: programs a person makes, sees answer, judges and
improves (design/74, 75). A hotkey only feeds one and delivers its answer.

## What it is

A **hotkey** is a key combination, a program made in Chattering, what it
reads, and where the answer goes:

| reads | |
|---|---|
| `selection` | the selected text (copied from the focused window, the clipboard put back) |
| `clipboard` | the text on the clipboard |

| the answer | |
|---|---|
| `replace` | pasted over the selection (only with `selection`); one Ctrl+Z undoes it |
| `paste` | pasted at the cursor |
| `clipboard` | copied, with a notification |
| `notify` | shown in a notification |

Each person has their own hotkeys (`<data>/hotkeys.json`, 0600). A hotkey
can name its own model (a small fast one makes it feel quick); thinking is
off for hotkeys. The program is any published made program with one text
input it can fill (others optional); its last answer is what is delivered.

**Starters** (settings → hotkeys): *Fix spelling and grammar*
(Super+Ctrl+G, selection → replace), *Translate to English* (Super+Ctrl+U; E is Omarchy's emoji picker),
*Explain this* (Super+Ctrl+Y, → notification). Choosing one makes its
program (`fix_writing`, `to_english`, `explain_text`) in this install's
own programs folder and publishes it, unless someone made it already; it
is then an ordinary program, editable and judged on its page.

## The pieces

```
 the person's computer                         their Chattering (here, or lambda)
 ─────────────────────────────────────         ──────────────────────────────────
 desktop (Hyprland) ── key ──► helper ──run──► /api/hotkeys/device/run
   hl.bind at run time        hotkeys-device.js   → the made program (madeCall)
 hotkeys-desktop.js ◄─ copy/paste, notify ─┘   ◄─ answer as text
                       ◄── long poll: hotkeys changed ── settings → hotkeys
```

- `hotkeys-keys.js` — one spelling of a combination everywhere
  (`Super+Ctrl+G`; Super is ⌘ on a Mac), shared by the page, the server
  and the helper. A letter or digit needs Ctrl, Alt or Super: Shift alone
  types a capital. Recording in the page uses the physical key (`e.code`).
- `hotkeys.js` — the store: hotkeys per person, linked computers, the
  codes waiting to be approved. Pure, tested without a server.
- `hotkeys-desktop.js` — one adapter per desktop; the only code that
  touches the desktop. Adding a system is one adapter.
- `hotkeys-device.js` — the helper: `chattering-app hotkeys connect | run
  | status | forget | autostart on|off`. `run` keeps the person's hotkeys
  on the desktop and does the work of a press; the bound key runs `press
  ID`, which hands the press to `run` over a socket (0600) in
  `$XDG_RUNTIME_DIR`. One press at a time.
- `hotkeys-ui.js` — settings → hotkeys.

## Linking a computer

Like a TV and a streaming account. The helper asks for a code
(`POST /api/hotkeys/pair`, no sign-in), shows it, and opens
`<address>/#hotkeys-connect=CODE`; the person, signed in, sees the
computer's name and the code and approves it. The helper's poll then gets a
credential (`chk_…`, 24 random bytes), once. Its SHA-256 is kept, never the
credential.

The credential opens `/api/hotkeys/device…` for that person and **nothing
else**: it lists their hotkeys and runs the programs they bound, with text
the computer sends. It cannot read a conversation, a file or another
program; any other route treats it as a failed sign-in (behind the same
limiter). Unlinking (on the page, or `forget` on the computer) ends it at
once, and wakes the computer's long poll so it hears so. A removed person
takes their hotkeys and computers along. Codes last ten minutes; at most 20
wait at once. Guests and walled people: no hotkeys (the program runs on the
owner's model outside their walls, as AI commands are refused to them).

## Hyprland

- **Keys.** A program cannot grab global keys on Wayland; the compositor
  must. The helper binds them at run time through Hyprland's Lua
  (`hyprctl eval`, `hl.bind(…, hl.dsp.exec_cmd(…), {description =
  "Chattering: …"})`, the call every Omarchy binding makes) and keeps the
  handles in a Lua global, so the next apply removes exactly its own and
  never a binding of the person's config. A combination the desktop already
  uses is not bound: it is reported back with the other binding's name and
  shown in settings ("already used there by …"). A configuration reload
  drops run-time binds; the event socket says `configreloaded` and they are
  bound again.
- **Copy and paste.** The chord is sent to the window itself
  (`send_key_state` with that window and exactly its modifiers), so the
  Super and Ctrl still held from the hotkey do not mix in. Terminals get
  Ctrl+Insert / Shift+Insert (Ctrl+C would interrupt their program). The
  paste goes through the clipboard: one undo step, no auto-indent, fast for
  long text; the person's clipboard is put back 600 ms later (nothing says
  when an app has read it). What the helper puts on the clipboard is marked
  sensitive so the clipboard history skips it.
- `wl-copy` forks a child that serves the clipboard and keeps every pipe it
  inherited: waiting on its output waits forever. Only its stdin is a pipe.

## Behaviour

- Switched windows while the program worked: the answer goes to the
  clipboard with a notification, never into the other window.
- Nothing selected: a notification, no call. More than 20,000 characters:
  refused.
- Replacing keeps the selection's leading and trailing space and line
  breaks. An answer equal to the selection: "No changes needed".
- A failed call says why in a notification; nothing is pasted.
- The helper's log (the journal) says which program ran, how long it took
  and whether it failed, never the text.

## Trade-offs, stated

- **What a hotkey reads leaves the computer**: to this Chattering, and to
  the program's model, like a message. It is recorded in the program's log
  with the answer, which the household can see on the program's page
  (design/74: the log is the household's, like the transcripts). A program
  for private text belongs on a model the person trusts.
- **The selection passes through the clipboard** for an instant; the
  clipboard history records that copy (the app makes it, not the helper).
- **Rich clipboard content comes back as text**: the clipboard is put back
  in one format (text first, else an image).
- **One person per desktop session.** On a computer several people share
  under one account (lambda), the helper runs the hotkeys of the person who
  linked it.
- **Speed**: a press is the copy (≈50 ms), `pi -p` and FunctAI's layout
  around the model's own time. With a fast model about 2 seconds; with a
  large one, 4–6.
- **Hyprland only.** The other desktops need, in order of effort: X11
  (xdotool, xclip); Windows (RegisterHotKey and SendInput, through a small
  PowerShell or native helper); GNOME and KDE (their global-shortcuts
  services); macOS (a signed helper with the Accessibility permission).
- **Screenshots are not inputs yet** (a window, a region, the screen): the
  Pi router carries text only. The next step: image parts through Pi's
  file arguments, then an `image` input in made programs.

## Verified

- `test/hotkeys.test.js`: combinations, refusals and the browser's keys;
  hotkeys as saved and their mistakes in sentences; which input a program
  takes; the store (one combination once, kept across restarts, 0600);
  linking (a code found when typed loosely, approved once, the credential
  once and only its hash on disk, refused, expired, unlinked waking the
  long poll); Hyprland names and Lua strings; the helper's press with a
  pretend desktop and server: replace with the spaces kept, notify,
  clipboard, a window change sending the answer to the clipboard, nothing
  selected, a failed program.
- `test/hotkeys-app.test.js`: the real app and server with a fake Pi: the
  grammar starter made and published from settings, a computer's code
  approved on the page it opens, the credential listing the hotkeys,
  running the program (thinking off, logged as a hotkey call) and refused
  everywhere else, refusals before any model, a computer's report shown,
  a change reaching the long poll at once, unlinking.
- On Hyprland 0.56 (lambda, the laptop): binding at run time, a taken
  combination reported with its owner's name, apply replacing and clearing
  exactly its own; on the laptop, a hidden browser text box: the selection
  read, the clipboard put back byte for byte, focus untouched, one undo
  restoring the text. A paste into a window without the keyboard focus
  pastes nothing (Wayland hands the clipboard to the focused app only), so
  that step was checked on a focused window in the `aikey` prototype the
  same day, through the same chord.
