# One computer, two sides: the Windows app and Chattering in WSL

Status: step 1 implemented (switching). Steps 2 and 3 are proposals.
Tested on Linux with both roles simulated (`test/localmachines*.test.js`); not yet on a real Windows PC.

## The question

A Windows PC can hold two Chattering installs for one person: the Windows
app (design/71) and the one inside WSL (`windows/`, Lilly's setup). Each
sees only its own side's conversations, agents and files. Can one window
reach both?

WSL is a second computer inside the first: other file paths, its own
tools and model sign-ins, and change notices do not cross. Reading the
other side's folders directly (`\\wsl.localhost\…` or `/mnt/c/…`) gives a
view that cannot safely act: an agent continued there would run on the
wrong side. So the two stay two installs, and the machine system joins
them, in three steps:

1. **Switch** (this note): one click moves the window to the other side,
   signed in.
2. **One list**: the other side's conversations appear here, labelled,
   read-only (a "my own machine" sync: every project, nothing redacted,
   updates within seconds). Proposal.
3. **Send to the owner**: writing in a conversation of the other side runs
   the agent there; its files open there. Proposal.

## What was in the way of the existing switcher

The switcher (settings → machines) was made for machines on a network:

- Pairing needs a pasted link, and "reach this machine from other devices"
  switched on on both sides, so two installs that share a computer had to
  open themselves to the network to find each other.
- WSL takes the Windows computer's name, so both sides were called the
  same: pairing refused the link as "this machine" (it compared names),
  and the list kept one entry per name.
- Both answer at `127.0.0.1` (WSL forwards its ports to Windows'
  localhost). A browser keeps one cookie jar per host name, whatever the
  port, and both installs used the cookie name `chattering`: signing in on
  one signed out of the other.
- A handoff from a paired install makes a *new member* unless the user ids
  match; the owner of one side arrived as a stranger on the other.

## How the two sides find each other

A folder both can reach, in the Windows account:
`%LOCALAPPDATA%\Chattering\local-machines\`. Each install writes a card
(`windows.json`, `wsl-<distro>-<user>.json`): kind, name, port(s),
signing key, version, time. Each reads the others' cards
(`localmachines.js`).

- The Windows app writes its card at every start (the port can change) and
  so makes the folder. A WSL install writes only once the folder exists:
  Chattering in WSL leaves no files on a Windows side without the app.
- WSL finds the Windows account's LocalAppData by asking Windows once
  (`cmd.exe /u /c echo %LOCALAPPDATA%`, UTF-16 so accented names
  survive, then `wslpath -u`), and keeps the answer in the cache folder.
  Without interop, the one account under `/mnt/c/Users` that has the
  folder is taken; with two or more, no guess.
  `CHATTERING_LOCAL_APPDATA` overrides.
- Cards are checked, not believed: kind, port range, key shape, a short
  name without control characters; a card not refreshed for 30 days is
  ignored (a running install rewrites it hourly).
- The list is kept apart from the pasted machines (`settings.machines`):
  nobody edits it by hand, it cannot be forged through the settings page,
  and it never shifts the pasted list's positions.

**Trust.** Only the Windows account can write that folder, and that account
already controls both installs (it reads the WSL files and runs anything
in the distro). So a key on a card is trusted for handoff, and a handoff
from the other side's *owner* signs in as this side's owner. Other people
arrive as they do from any paired install. Trade-off: Linux accounts in
one WSL distro are not walls against each other here, as they are not in
WSL at all (any of them can run Windows programs as the Windows account).

## Switching

- The page is told of `localMachines` (name, kind, port; never the key)
  and offers them first in the switcher, "Linux, on this computer" /
  "Windows, on this computer". Only to a browser on this computer
  (`127.0.0.1`, `localhost`): a phone reaching the WSL install through the
  LAN forward cannot reach the Windows app's `127.0.0.1`.
- A click asks this install for a handoff (`/api/handoff?local=<id>`, the
  card re-read so a new port counts), checks from the page that the other
  answers (`fetch(…/health, {mode: 'no-cors'})`: a refused connection
  fails, any answer does not), and goes there. The address is built on the
  page's own host name, so both sides live in one cookie jar.
- Names: the Linux side calls itself `<computer> (Linux)`
  (`MACHINE_NAME`), in the switcher and towards peers it pairs with.
  `HOST_NAME` (memory documents, sync) is unchanged: renaming it would
  re-file what peers and memory already know. Step 2 must revisit it,
  since mirrored memory from both sides would then say "this machine:
  LILLY-PC" for two different sets of paths.

## Sign-in cookies

Each install's cookie is `chattering_<8 hex of its key>`. Older names are
honoured and moved: `chattering` (until this change) and `aiconvo` (until
2026-09-22). A `chattering` cookie that names nobody here is refused but
**not cleared**: it may be the other side's, still on an older version.
Clearing a stale cookie now clears only the own name (and `aiconvo`). The
sign-in limiter already counts a repeated stale secret once.

## Same port

If the Windows app starts first on `7433` while WSL is stopped, WSL's
forward of its own `7433` fails when it starts, and `127.0.0.1:7433` is the
Windows app. The launcher now keeps clear of every port on a WSL card.
If it happens anyway (the first time, before any card exists), both
sides mark the other `same-port` and the switcher says to restart
Chattering on Windows instead of taking the person to the wrong one.

Not fixed here: the WSL desktop shortcut (`windows/launch.ps1`) opens
`localhost:<port>` and checks `/health`; in that first-time collision it
would open the Windows app.

## Not done, stated

- Not run on a real Windows PC yet. Assumptions to check there: WSL's
  localhost forward reaches a WSL server bound to `127.0.0.1`
  (the WSL launcher relies on it today); `cmd.exe /u` from a systemd
  service with `WSL_INTEROP` set; mirrored networking mode.
- One list and send-to-owner (steps 2 and 3).
