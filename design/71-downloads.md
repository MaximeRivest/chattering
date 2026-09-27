# 71 · Downloads: one archive per system

*2026-09-26. `scripts/build-release.js`, `scripts/smoke-release.js`,
`launcher.js`, `install/install.sh`, `install/install.ps1`,
`.github/workflows/package.yml` and `release.yml`. Tests `launcher`. Step 3
of the market-readiness work.*

## What a person gets

`chattering-<version>-<linux|macos|win>-<x64|arm64>.tar.gz` (`.zip` on
Windows), with its SHA-256 in the release's `SHA256SUMS`:

- the app (what git tracks, minus tests, design notes, Android, WSL helpers);
- `runtime/node/`: the Node that built it (`.node-version`, 24);
- `runtime/node_modules/`: Pi exactly as `runtime/package-lock.json` locks it,
  esbuild trimmed to this system's binary (Pi's shrinkwrap installs all 26,
  280 MB);
- `BUILD.json` (version, commit, Node, Pi, date, system) and
  `THIRD_PARTY.md` (licenses of what ships beside the app).

About 90 MB compressed, 320 MB unpacked: Node itself and Pi's model-provider
libraries are most of it.

## Installing

    curl -fsSL https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.sh | sh
    irm https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.ps1 | iex

Per person, no administrator rights. The script checks the checksum, unpacks
into `versions/<version>` (Linux `~/.local/share/chattering-program`, macOS
`~/Library/Application Support/Chattering/program`, Windows
`%LOCALAPPDATA%\Programs\Chattering`), adds two commands, a menu entry, and
starts Chattering:

- `chattering-app`: open (start if needed), `start`, `stop [--force]`,
  `status`, `url`, `logs`, `autostart on|off`, `update [--force]`,
  `rollback`, `version`.
- `chattering`: the records command (search and read conversations), as on
  the machines where Chattering was born.

## Running

The launcher starts the server in the background as the signed-in person,
on this machine only, on 7433 or the next free port; it recognises its own
server by asking `/api/app/status` with this install's token (a port that
answers proves nothing). It opens an app window from Chrome, Edge or
Chromium when one is installed, else the default browser, signed in with the
token. Closing the browser leaves work running; `chattering-app stop`
stops it, waiting for running work unless `--force` (`/api/app/stop`, since
Windows has no polite signal).

## Updating

`chattering-app update` reads the latest release, refuses while work is
running (unless `--force`), downloads, checks the checksum, unpacks beside
the current version, stops, switches (`current.txt`, and the `current`
link on Unix), starts again. The previous version stays:
`chattering-app rollback`. Nothing in the data folders is touched by an
update or by removing a version.

## Released only if a stranger could use it

Every push builds the downloads for Linux, macOS and Windows and runs the
stranger test on each **unpacked archive** (`smoke-release.js`): a home that
never saw Chattering, PATH with only the system's folders, start with the
launcher, find an existing conversation in its project, word search, the
page, the records command, Pi answering from the bundled runtime, stop. A
tag `v<version>` does the same on six system/processor pairs and publishes
nothing unless all pass.

## Trade-offs, stated

- **Not code-signed.** Signing needs an Apple Developer ID and a Windows
  code-signing certificate, which Rockfrog does not have yet. The install
  scripts avoid the warnings (a file fetched by curl or Invoke-WebRequest is
  not quarantined; the script unblocks what it unpacks); an archive
  downloaded by a browser and opened by hand will meet Gatekeeper and
  SmartScreen. Node itself is signed by its publisher.
- **Installers (2026-09-27, design/73):** a `.dmg` for macOS and a per-person
  Inno Setup for Windows, built from this archive by
  `scripts/build-installer.js` and given their own stranger test
  (`scripts/smoke-installer.js`). The Windows Start menu opens a windowless
  `Chattering.exe` (no console flash); the Mac app has its icon. Their names
  carry no version, for `releases/latest/download/` links.
- **Size.** Pruning Pi's provider libraries would break providers people use.
