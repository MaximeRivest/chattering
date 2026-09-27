# 70 · Every system: Linux, macOS, Windows

*2026-09-26. Modules `platform.js`, `runtime.js`, `processes.js`;
`agentpath.js` rewritten. Tests `platform`, `processes`, `agentpath`, and
the whole suite on three systems in CI (`.github/workflows/ci.yml`). Step 2
of the market-readiness work; design/62 was the investigation.*

## The rule

A question whose answer depends on the operating system is asked in one
place, never tested with `process.platform` where it is used:

| Question | Where |
|---|---|
| which system; WSL | `platform.hostKind()`, `IS_WIN/IS_MAC/IS_LINUX/IS_WSL` |
| PATH: its name (`Path` on Windows), separator, lookup (PATHEXT) | `platform.pathKey/withPath/findOnPath` |
| is this path inside that folder (access checks) | `platform.isInside` (resolves, case-insensitive on Windows and macOS) |
| a conversation's key ↔ its file | `sessionKey` in server.js: forward slashes in keys on every system; `absPathForKey` back to native |
| Chattering's own folders | `platform.appDirs()` |
| Pi: which, how to start it, its folder, its session-folder names | `runtime.js` |
| running processes, a process's identity, stopping a tree | `processes.js` |
| opening a file, showing it in the file manager | `platform.openCommand` |
| playing a sound, recording the room microphone | `platform.audioPlayCommand/audioRecordCommand` |
| an agent's PATH | `agentpath.js` |
| where a step's local file may be captured or shown; what is a secret | `task-locations.js` `permittedLocal`, `sensitive` (either separator) |
| a path in an agent's tool call, local or remote | `task-locations.js` `location` (this system's rules locally, POSIX on a remote host) |
| in the page: is this a full path, is it inside that folder | `isFullPath`, `pathWithin` (app.html's first script; either separator, drive letters without case) |
| in the page: the command key | `IS_MAC`, `modHeld(e)`, `modKey('K')` (app.html's first script, CodeMirror's own rule) |

## Decisions

- **Pi is started as `node <pi's cli.js>`**, from the package the resolver
  found: the pinned runtime beside the code (`runtime/`), else an installed
  Pi. Never through the `pi` shim: a Windows shim is a `.cmd` file that
  cannot be spawned without a shell, and PATH differs between a service and
  a terminal. `runtime/package.json` is the one source of the tested Pi
  version; `runtime/package-lock.json` pins its dependencies.
- **Session folders are named exactly as Pi names them** (one leading
  separator dropped, every `/ \ :` a dash). The copy that forgot `:` would
  have looked for Windows conversations where there are none.
- **Existing folders never move.** An install that has `~/.config/chattering`
  (and the others) keeps them, on every system, including the outside
  contributor's macOS install. A new install on macOS uses
  `~/Library/Application Support/Chattering` and `~/Library/Caches/Chattering`;
  on Windows `%APPDATA%\Chattering` and `%LOCALAPPDATA%\Chattering`.
- **Pi's folder follows Pi's rule** (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`).
- **Processes:** Linux reads `/proc`; macOS asks `ps` and `sysctl`; Windows
  asks the process table through PowerShell, answering from a snapshot
  refreshed every ten seconds in the background, and caching a process's
  start time while it lives. A delegated worker's identity (start time and
  boot) now exists on all three, so workers are no longer "lost" off Linux.
  Windows stops a worker's tree with `taskkill /T /F`, except a nested
  delegation's supervisor and what it runs (`stopTree`'s `spare`): on Unix
  those lead their own process group, see the cancel in their records, and
  end as cancelled; on Windows too now, rather than as lost.
- **PowerShell without cmdlets.** The process list, start times and boot
  time come from .NET and WMI directly (`[System.Diagnostics.Process]`,
  `ManagementObjectSearcher`), never `Get-Process`, `Get-CimInstance`,
  `New-Object` or `Add-Type`: a cmdlet's first use makes PowerShell scan
  every installed module, which without its per-user cache in AppData took
  over ten seconds on CI and failed every delegation in a fresh profile.
  PowerShell itself is started from `%SystemRoot%\System32`, not by PATH.
  The server starts its first listing in the background at startup
  (`processes.warm()`) and never waits for it.
- **The command key is ⌘ on a Mac** where Ctrl has a text meaning there:
  Ctrl+K deletes to the line's end and Ctrl+F moves the cursor, in the editor
  and in every Mac text field. So the ask box (K) and find (F) take ⌘ on a
  Mac and Ctrl elsewhere (`modHeld`), labels and the help name the key that
  works (`modKey`), and voice undo and redo press the editor's own keys
  (⌘Z, ⌘⇧Z). Shortcuts with no Mac text meaning (Enter, S, R, M) accept
  either. The help stays Ctrl+? everywhere: ⌘? is the Mac's Help menu.
  `test/mac-keys.test.js` checks this on any system (Chrome reports a Mac).
- **Paths arrive in the system's own form.** Windows paths are
  `C:\…` in the page too: a leading `/` never means "absolute" there, a file
  name is split on either separator, and a drive letter is not a URL scheme.
- **What a machine cannot do is said, not failed** (`capabilities` in
  `GET /api/settings`): terminal windows (Linux with Alacritty and
  Python), sound on this machine, the room microphone (Linux with
  PipeWire), notebooks (a `rat` new enough). A terminal launch without a
  terminal answers with the reason; a Claude Code conversation's send
  button says why it cannot continue there.

## Trade-offs, stated

- **Windows has no terminal windows** (the PTY bridge is Unix); conversations
  continue in the page. Claude Code conversations, which only continue in a
  terminal, can be read and forked there, not continued.
- **Guest and per-person walls need Linux with bubblewrap.** Elsewhere a
  walled person reads and writes but runs nothing; the message says so.
- **File privacy on Windows** comes from the per-user folder's access list,
  not from Unix permission bits (which Windows ignores). Chattering's
  folders sit in the person's profile, private by default.
- **Windows process listing costs about a second** in PowerShell; hence the
  background snapshot, which can be ten seconds old. Until the server's first
  listing arrives (a second or two after it starts), it sees no running
  agent processes. A new process's identity still costs one PowerShell call
  (cached while it lives).
- **Windows has no polite stop for console programs**: cancelling a worker
  ends it at once (Unix asks with SIGTERM first). Pi's session file is
  appended line by line, so at worst the last line is cut short.
- **The room microphone** stays Linux-only (PipeWire); the browser's
  microphone works everywhere.
- **Notebooks need a `rat` that is not yet published.** The released `rat`
  (a9a74ed) lacks `run --doc` and `doctor --json`, which Chattering uses;
  the notebook tests say so and skip on CI until it is. Publishing rat
  makes them run everywhere.

## CI notes

- On macOS, setup-chrome's channel installs drop the `.app` from Chrome's
  path; started from there, Chrome's helper processes die at birth and no
  page answers. `.github/actions/chrome` hands on a path through a `.app`
  link (setup-chrome#658).
- Never run `chrome --version` on Windows (tests, CI steps): it opens a
  browser and does not return. Tests ask `chromiumAvailable()`.
- Tests press the system's command key (`MOD` in `test/helpers/chromium.js`).

## Verified

The whole suite on Linux (Node 22 and the pinned 24), macOS and Windows in
CI; see the run on the `portability` branch. Locally on NixOS: 850 tests,
none skipped.
